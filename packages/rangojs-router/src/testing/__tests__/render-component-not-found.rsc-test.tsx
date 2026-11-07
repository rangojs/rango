/**
 * A server component that throws notFound() while React renders it.
 *
 * It is not a handler's throw, so catchSegmentError never sees it: React
 * reports it to the Flight onError and renders the nearest client boundary,
 * and the request used to answer a 200 error page (a document) or an error
 * row (a client navigation). The render answers it instead: the route renders
 * again with the fallback a notFound() from its handler renders (the nearest
 * notFoundBoundary, else the router's notFound option), and the 404.
 *
 * A notFound() that arrives AFTER the body started streaming (a route with
 * loading(), a streamed handler) keeps the error row it always had: the status
 * line has already committed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";

vi.mock(
  "@vitejs/plugin-rsc/rsc/server",
  () => import("../vitest-stubs/plugin-rsc.js"),
);
vi.mock(
  "@vitejs/plugin-rsc/rsc/client",
  () => import("../vitest-stubs/plugin-rsc.js"),
);

import { resetShellTestState, serveShellRequest } from "../flight.entry.js";
import { createRouter, notFound, redirect, urls } from "../../index.rsc.js";
import { MemorySegmentCacheStore } from "../../cache/index.js";

function ThrowSync(): React.ReactNode {
  throw notFound("no such product");
}

async function ThrowAsync(): Promise<React.ReactNode> {
  await Promise.resolve();
  throw notFound("no such product");
}

function Nested(): React.ReactNode {
  return (
    <section>
      <h2>product</h2>
      <ThrowSync />
    </section>
  );
}

function RedirectAndNotFound(): React.ReactNode {
  return (
    <>
      <ThrowSync />
      <ThrowRedirect />
    </>
  );
}

function ThrowRedirect(): React.ReactNode {
  throw redirect("/target", 302);
}

// A loading() route's handler streams: its notFound() is recovered into the
// declared boundary as the stream runs, with no status write, and recorded in
// the request's _renderErrors. Rejecting at once, it is recorded before the
// render decides; it is not a component's throw and must not be answered as one.
async function streamedMissing(): Promise<React.ReactNode> {
  notFound("streamed missing");
}

function Boom(): React.ReactNode {
  throw new Error("render boom");
}

const patterns = urls(
  ({ path, layout, loading, errorBoundary, notFoundBoundary }) => [
    layout(
      ({ children }: { children?: React.ReactNode }) => (
        <main>
          <nav>site-nav</nav>
          {children}
        </main>
      ),
      () => [
        errorBoundary(({ error }) => <p>declared-error:{error.message}</p>),
        notFoundBoundary(({ notFound }) => (
          <p>
            declared-not-found:{notFound.message}:{notFound.segmentType}
          </p>
        )),
        path("/throw", () => <ThrowSync />, { name: "throw" }),
        path("/throw-async", () => <ThrowAsync />, { name: "throwAsync" }),
        path("/throw-nested", () => <Nested />, { name: "throwNested" }),
        path("/handler", () => notFound("no such product"), {
          name: "handler",
        }),
        path("/both", () => <RedirectAndNotFound />, { name: "both" }),
        path("/boom", () => <Boom />, { name: "boom" }),
        path("/streamed", streamedMissing, { name: "streamed" }, () => [
          loading(<p>streamed-loading</p>),
        ]),
        path("/ok", async () => <p>fine</p>, { name: "ok" }),
      ],
    ),
  ],
);

const patternsNoBoundary = urls(({ path }) => [
  path("/throw", () => <ThrowSync />, { name: "throw" }),
  path("/ok", async () => <p>fine</p>, { name: "ok" }),
]);

function makeRouter(
  routes: typeof patterns = patterns,
  options: Parameters<typeof createRouter>[0] = {},
) {
  return createRouter({ onError: vi.fn(), ...options }).routes(routes);
}

function serve(
  router: Parameters<typeof serveShellRequest>[0],
  path: string,
  options: Parameters<typeof serveShellRequest>[2] = {},
) {
  return serveShellRequest(router, path, {
    cacheStore: new MemorySegmentCacheStore(),
    ...options,
  });
}

/** A Flight error row: what the client's boundary renders from. */
const ERROR_ROW = /^\d+:E\{/m;

beforeEach(() => resetShellTestState());

describe("a component that throws notFound()", () => {
  it("document: answers a 404 with the declared notFoundBoundary inside the layout", async () => {
    const res = await serve(makeRouter(), "/throw");
    expect(res.response.status).toBe(404);
    expect(res.flight).toContain("declared-not-found:");
    expect(res.flight).toContain("no such product");
    expect(res.flight).toContain("site-nav");
    expect(res.flight).not.toMatch(ERROR_ROW);
  });

  it("document: renders what the same notFound() from the route's handler renders", async () => {
    const fromComponent = await serve(makeRouter(), "/throw");
    resetShellTestState();
    const fromHandler = await serve(makeRouter(), "/handler");
    expect(fromHandler.response.status).toBe(404);
    for (const res of [fromComponent, fromHandler]) {
      expect(res.flight).toContain('"route"');
      expect(res.flight).toContain("no such product");
    }
  });

  it("document: an async component answers the same 404", async () => {
    const res = await serve(makeRouter(), "/throw-async");
    expect(res.response.status).toBe(404);
    expect(res.flight).toContain("declared-not-found:");
    expect(res.flight).not.toMatch(ERROR_ROW);
  });

  it("document: a component nested in the route's markup answers the same 404", async () => {
    const res = await serve(makeRouter(), "/throw-nested");
    expect(res.response.status).toBe(404);
    expect(res.flight).toContain("declared-not-found:");
    expect(res.flight).not.toMatch(ERROR_ROW);
  });

  it("document: with no notFoundBoundary the router's notFound option renders", async () => {
    const router = makeRouter(patternsNoBoundary as typeof patterns, {
      notFound: <p>router-not-found</p>,
    });
    const res = await serve(router, "/throw");
    expect(res.response.status).toBe(404);
    expect(res.flight).toContain("router-not-found");
    expect(res.flight).not.toMatch(ERROR_ROW);
  });

  it("document: a redirect thrown in the same render wins", async () => {
    const res = await serve(makeRouter(), "/both");
    expect(res.response.status).toBe(302);
    expect(res.response.headers.get("location")).toBe("/target");
  });

  it("document: an ordinary boundary error still answers its 200 page", async () => {
    const res = await serve(makeRouter(), "/boom");
    expect(res.response.status).toBe(200);
    expect(res.flight).toMatch(ERROR_ROW);
  });

  it("navigation: renders the declared notFoundBoundary with the 404", async () => {
    const res = await serve(makeRouter(), "/throw", {
      partial: { from: "/ok" },
    });
    expect(res.response.status).toBe(404);
    expect(res.flight).toContain("declared-not-found:");
    expect(res.flight).toContain("no such product");
    expect(res.flight).not.toMatch(ERROR_ROW);
  });

  // The limit an async component's redirect() shares on this channel: the
  // response is decided once the Flight body's opening chunk is out, and an
  // async component's row lands in a later chunk.
  it("navigation: an async component's notFound() lands after the decision and keeps its error row", async () => {
    const res = await serve(makeRouter(), "/throw-async", {
      partial: { from: "/ok" },
    });
    expect(res.response.status).toBe(200);
    expect(res.flight).toMatch(ERROR_ROW);
  });

  it("navigation: a prefetch answers the same 404", async () => {
    const res = await serve(makeRouter(), "/throw", {
      partial: { from: "/ok", prefetch: true },
    });
    expect(res.response.status).toBe(404);
    expect(res.flight).toContain("declared-not-found:");
    expect(res.flight).not.toMatch(ERROR_ROW);
  });

  it("navigation: an ordinary boundary error still renders the boundary", async () => {
    const res = await serve(makeRouter(), "/boom", {
      partial: { from: "/ok" },
    });
    expect(res.response.status).toBe(200);
    expect(res.flight).toMatch(ERROR_ROW);
  });

  it("a loading() route's recovered notFound() is not answered again", async () => {
    for (const partial of [undefined, { from: "/ok" }]) {
      resetShellTestState();
      const res = await serve(makeRouter(), "/streamed", { partial });
      expect(res.response.status).toBe(200);
      expect(res.flight).toContain("declared-not-found:");
      expect(res.flight).toContain("streamed missing");
    }
  });

  it("a healthy page renders unchanged", async () => {
    const res = await serve(makeRouter(), "/ok");
    expect(res.response.status).toBe(200);
    expect(res.flight).toContain("fine");
  });
});
