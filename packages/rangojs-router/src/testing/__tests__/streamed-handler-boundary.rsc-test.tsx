/**
 * A route handler that declares loading() streams after the response starts.
 * When its promise rejects (or calls notFound()), the nearest declared
 * errorBoundary() / notFoundBoundary() fallback renders in its place, on the
 * document request and on a client navigation. Status stays what the stream
 * already sent; onError fires once; with no declared boundary the rejection
 * still reaches the stream (RootErrorBoundary on the client).
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

const Loading = <p>loading-fallback</p>;

async function failLater(): Promise<React.ReactNode> {
  await new Promise((r) => setTimeout(r, 5));
  throw new Error("streamed boom");
}

async function missingLater(): Promise<React.ReactNode> {
  await new Promise((r) => setTimeout(r, 5));
  notFound("streamed missing");
  return null;
}

async function redirectLater(): Promise<React.ReactNode> {
  await new Promise((r) => setTimeout(r, 5));
  throw redirect("/ok");
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
        notFoundBoundary(() => <p>declared-not-found</p>),
        path("/fails", failLater, { name: "fails" }, () => [loading(Loading)]),
        path("/missing", missingLater, { name: "missing" }, () => [
          loading(Loading),
        ]),
        path("/fails-no-ssr", failLater, { name: "failsNoSsr" }, () => [
          loading(Loading, { ssr: false }),
        ]),
        path("/redirects", redirectLater, { name: "redirects" }, () => [
          loading(Loading),
        ]),
        path(
          "/ok",
          async () => <p>fine</p>,
          { name: "ok" },
          () => [loading(Loading)],
        ),
      ],
    ),
  ],
);

function makeRouter(onError = vi.fn()) {
  return {
    onError,
    router: createRouter({ onError }).routes(patterns),
  };
}

beforeEach(() => resetShellTestState());

describe("streamed handler declared boundary (serveShellRequest)", () => {
  it("document: a rejecting handler renders the declared errorBoundary, status stays 200, onError once", async () => {
    const { router, onError } = makeRouter();
    const res = await serveShellRequest(router, "/fails", {
      cacheStore: new MemorySegmentCacheStore(),
    });
    expect(res.response.status).toBe(200);
    expect(res.flight).toContain("declared-error");
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("navigation: the declared errorBoundary renders in the partial response", async () => {
    const { router, onError } = makeRouter();
    const res = await serveShellRequest(router, "/fails", {
      cacheStore: new MemorySegmentCacheStore(),
      partial: { from: "/ok" },
    });
    expect(res.flight).toContain("declared-error");
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("document: notFound() renders the declared notFoundBoundary", async () => {
    const { router } = makeRouter();
    const res = await serveShellRequest(router, "/missing", {
      cacheStore: new MemorySegmentCacheStore(),
    });
    expect(res.response.status).toBe(200);
    expect(res.flight).toContain("declared-not-found");
  });

  it("navigation: notFound() renders the declared notFoundBoundary", async () => {
    const { router } = makeRouter();
    const res = await serveShellRequest(router, "/missing", {
      cacheStore: new MemorySegmentCacheStore(),
      partial: { from: "/ok" },
    });
    expect(res.flight).toContain("declared-not-found");
  });

  it("loading({ ssr: false }): the document and the navigation both show the declared errorBoundary", async () => {
    const { router } = makeRouter();
    const doc = await serveShellRequest(router, "/fails-no-ssr", {
      cacheStore: new MemorySegmentCacheStore(),
    });
    expect(doc.flight).toContain("declared-error");
    const nav = await serveShellRequest(router, "/fails-no-ssr", {
      cacheStore: new MemorySegmentCacheStore(),
      partial: { from: "/ok" },
    });
    expect(nav.flight).toContain("declared-error");
  });

  it("a redirect thrown from a streamed handler stays an error row in the stream", async () => {
    const { router } = makeRouter();
    const res = await serveShellRequest(router, "/redirects", {
      cacheStore: new MemorySegmentCacheStore(),
    });
    // Unchanged by the boundary lane: no HTTP redirect after flush, the
    // rejection rides the stream as an error row (client RootErrorBoundary).
    expect(res.response.status).toBe(200);
    expect(res.response.headers.get("location")).toBeNull();
    expect(res.flight).not.toContain("declared-error");
    expect(res.flight).toMatch(/^\d+:E\{/m);
  });

  it("a healthy streamed handler renders unchanged", async () => {
    const { router, onError } = makeRouter();
    const res = await serveShellRequest(router, "/ok", {
      cacheStore: new MemorySegmentCacheStore(),
    });
    expect(res.flight).toContain("fine");
    expect(res.flight).not.toContain("declared-error");
    expect(onError).not.toHaveBeenCalled();
  });

  it("with no declared boundary the rejection still reaches the stream", async () => {
    const onError = vi.fn();
    const router = createRouter({ onError }).routes(
      urls(({ path, loading }) => [
        path("/fails", failLater, { name: "fails" }, () => [loading(Loading)]),
      ]),
    );
    const res = await serveShellRequest(router, "/fails", {
      cacheStore: new MemorySegmentCacheStore(),
    });
    expect(res.flight).not.toContain("declared-error");
    expect(res.flight).toMatch(/^\d+:E\{/m);
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
