/**
 * A server component that throws notFound() while React renders it.
 *
 * It is not a handler's throw, so catchSegmentError never sees it: React
 * reports it to the Flight onError and renders the nearest client boundary,
 * and the request used to answer a 200 error page (a document) or an error
 * row (a client navigation). The render answers it instead: the page renders
 * again with what a notFound() from the throwing segment's handler renders
 * (the nearest notFoundBoundary, else the router's notFound option), and the
 * 404. That holds for a route's component, a layout's, a parallel slot's, an
 * orphan layout's and an intercept slot's: the payload is the one the same
 * notFound() thrown by that segment's handler gives.
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
import { deserializeResult } from "../../cache/segment-codec.js";

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

// Each `/x` (a component throws) has a `/x-handler` twin built the same way
// whose segment's handler throws the same notFound().
const segmentPatterns = urls(
  ({ path, layout, parallel, intercept, notFoundBoundary }) => [
    layout(
      ({ children }: { children?: React.ReactNode }) => (
        <main>
          <nav>site-nav</nav>
          {children}
        </main>
      ),
      () => [
        notFoundBoundary(({ notFound }) => (
          <p>
            declared-not-found:{notFound.message}:{notFound.segmentType}
          </p>
        )),
        layout(
          () => (
            <section>
              <ThrowSync />
            </section>
          ),
          () => [path("/layout", () => <p>page</p>, { name: "layout" })],
        ),
        layout(
          () => notFound("no such product"),
          () => [
            path("/layout-handler", () => <p>page</p>, {
              name: "layoutHandler",
            }),
          ],
        ),
        layout(
          () => (
            <section>
              <ThrowAsync />
            </section>
          ),
          () => [
            path("/layout-async", () => <p>page</p>, { name: "layoutAsync" }),
          ],
        ),
        layout(
          () => <section>slot-owner</section>,
          () => [
            parallel({ "@side": () => <ThrowSync /> }),
            path("/slot", () => <p>page</p>, { name: "slot" }),
          ],
        ),
        layout(
          () => <section>slot-owner</section>,
          () => [
            parallel({ "@side": () => notFound("no such product") }),
            path("/slot-handler", () => <p>page</p>, { name: "slotHandler" }),
          ],
        ),
        layout(
          () => <section>orphan-owner</section>,
          () => [
            layout(() => (
              <aside>
                <ThrowSync />
              </aside>
            )),
            path("/orphan", () => <p>page</p>, { name: "orphan" }),
          ],
        ),
        layout(
          () => <section>orphan-owner</section>,
          () => [
            layout(() => notFound("no such product")),
            path("/orphan-handler", () => <p>page</p>, {
              name: "orphanHandler",
            }),
          ],
        ),
        layout(
          () => (
            <section>
              <ThrowSync />
            </section>
          ),
          () => [
            path("/layout-and-route", () => <ThrowSync />, { name: "lr" }),
          ],
        ),
        path("/list", () => <ul>list</ul>, { name: "list" }),
        path("/photo/:id", () => <figure>photo</figure>, { name: "photo" }),
        path("/photo-handler/:id", () => <figure>photo</figure>, {
          name: "photoHandler",
        }),
        intercept("@modal", ".photo", () => <ThrowSync />),
        intercept("@modal", ".photoHandler", () => notFound("no such product")),
        // The layout that declares an intercept throws on the intercepted
        // page only.
        layout(
          (ctx) => (
            <section>
              {ctx.url.pathname.includes("/gallery/") ? <ThrowSync /> : null}
            </section>
          ),
          () => [
            path("/gallery", () => <ul>gallery</ul>, { name: "gallery" }),
            path("/gallery/:id", () => <figure>photo</figure>, {
              name: "galleryPhoto",
            }),
            intercept("@modal", ".galleryPhoto", () => (
              <figure>gallery-modal</figure>
            )),
          ],
        ),
      ],
    ),
  ],
);

interface Metadata {
  segments: Array<{
    id: string;
    type: string;
    notFoundInfo?: { segmentType: string };
  }>;
  matched: string[];
  diff: string[];
  slots?: Record<string, { segments?: Array<{ id: string }> }>;
}

async function metadataOf(res: { flight?: string }): Promise<Metadata> {
  return (await deserializeResult<{ metadata: Metadata }>(res.flight!))
    .metadata;
}

/**
 * A payload with its ids replaced by what they are, so a page and its
 * handler twin (other shortCodes, the same structure) compare equal.
 */
function shapeOf(metadata: Metadata) {
  const typeOf = new Map(
    metadata.segments.map((s) => [
      s.id,
      s.notFoundInfo ? `notFound(${s.notFoundInfo.segmentType})` : s.type,
    ]),
  );
  const name = (id: string) => typeOf.get(id) ?? "held";
  return {
    segments: metadata.segments.map((s) => name(s.id)),
    matched: metadata.matched.map(name),
    diff: metadata.diff.map(name),
  };
}

describe("a layout's, a slot's and an intercept's component that throws notFound()", () => {
  const router = () =>
    createRouter({ onError: vi.fn() }).routes(
      segmentPatterns as unknown as typeof patterns,
    );

  /** `path` and its handler twin, served the same way. */
  async function twins(
    path: string,
    twin: string,
    options: Parameters<typeof serve>[2] = {},
  ) {
    const fromComponent = await serve(router(), path, options);
    resetShellTestState();
    const fromHandler = await serve(router(), twin, options);
    return { fromComponent, fromHandler };
  }

  for (const [label, partial] of [
    ["document", undefined],
    ["navigation", { from: "/list" }],
  ] as const) {
    it(`${label}: a layout's component renders what its handler's notFound() renders, with the 404`, async () => {
      const { fromComponent, fromHandler } = await twins(
        "/layout",
        "/layout-handler",
        { partial },
      );
      expect(fromComponent.response.status).toBe(404);
      expect(fromComponent.flight).not.toMatch(ERROR_ROW);
      expect(fromComponent.flight).toContain("declared-not-found:");
      expect(fromComponent.flight).toContain("no such product");
      expect(fromComponent.flight).toContain("site-nav");
      const shape = shapeOf(await metadataOf(fromComponent));
      expect(shape).toEqual(shapeOf(await metadataOf(fromHandler)));
      // The layout's own id is gone: a navigation holds a layout it has, so
      // the fallback must not be kept under it.
      expect(shape.matched).toEqual([
        "layout",
        "layout",
        "notFound(layout)",
        "route",
      ]);
    });

    it(`${label}: a parallel slot's component renders what its handler's notFound() renders, with the 404`, async () => {
      const { fromComponent, fromHandler } = await twins(
        "/slot",
        "/slot-handler",
        { partial },
      );
      expect(fromComponent.response.status).toBe(404);
      expect(fromComponent.flight).not.toMatch(ERROR_ROW);
      expect(fromComponent.flight).toContain("declared-not-found:");
      const shape = shapeOf(await metadataOf(fromComponent));
      expect(shape).toEqual(shapeOf(await metadataOf(fromHandler)));
      expect(shape.segments).toContain("notFound(parallel)");
      expect(shape.segments).not.toContain("parallel");
    });

    it(`${label}: an orphan layout's component renders what its handler's notFound() renders, with the 404`, async () => {
      const { fromComponent, fromHandler } = await twins(
        "/orphan",
        "/orphan-handler",
        { partial },
      );
      expect(fromComponent.response.status).toBe(404);
      expect(fromComponent.flight).not.toMatch(ERROR_ROW);
      expect(shapeOf(await metadataOf(fromComponent))).toEqual(
        shapeOf(await metadataOf(fromHandler)),
      );
    });

    it(`${label}: a layout's and its route's components that both throw leave no error row`, async () => {
      const res = await serve(router(), "/layout-and-route", { partial });
      expect(res.response.status).toBe(404);
      expect(res.flight).not.toMatch(ERROR_ROW);
      expect(shapeOf(await metadataOf(res)).segments).toEqual([
        "layout",
        "layout",
        "notFound(layout)",
        "notFound(route)",
      ]);
    });
  }

  it("document: a layout's async component answers the same 404", async () => {
    const res = await serve(router(), "/layout-async");
    expect(res.response.status).toBe(404);
    expect(res.flight).not.toMatch(ERROR_ROW);
    expect(shapeOf(await metadataOf(res)).segments).toContain(
      "notFound(layout)",
    );
  });

  it("navigation that holds the outer layouts: a layout's component answers the 404", async () => {
    const list = await serve(router(), "/list", { partial: true });
    const segments = (await metadataOf(list)).matched;
    resetShellTestState();
    const res = await serve(router(), "/layout", {
      partial: { from: "/list", segments },
    });
    expect(res.response.status).toBe(404);
    expect(res.flight).not.toMatch(ERROR_ROW);
    const shape = shapeOf(await metadataOf(res));
    expect(shape.matched).toEqual([
      "held",
      "held",
      "notFound(layout)",
      "route",
    ]);
    expect(shape.segments).toEqual(["notFound(layout)", "route"]);
  });

  it("intercept navigation: the slot's component renders the fallback in the slot, as its handler's notFound() does", async () => {
    const list = await serve(router(), "/list", { partial: true });
    const segments = (await metadataOf(list)).matched;
    resetShellTestState();
    const { fromComponent, fromHandler } = await twins(
      "/photo/1",
      "/photo-handler/1",
      { partial: { from: "/list", segments } },
    );
    expect(fromComponent.response.status).toBe(404);
    expect(fromComponent.flight).not.toMatch(ERROR_ROW);
    expect(fromComponent.flight).toContain("declared-not-found:");
    expect(fromComponent.flight).toContain('"parallel"');
    const component = await metadataOf(fromComponent);
    expect(shapeOf(component)).toEqual(shapeOf(await metadataOf(fromHandler)));
    expect(component.slots?.["@modal"]?.segments?.length).toBe(1);
  });

  it("intercept navigation: the declaring layout's component answers its .notFound and keeps the intercept's slot", async () => {
    const res = await serve(router(), "/gallery/1", {
      partial: { from: "/gallery" },
    });
    expect(res.response.status).toBe(404);
    expect(res.flight).not.toMatch(ERROR_ROW);
    const metadata = await metadataOf(res);
    expect(shapeOf(metadata).segments).toEqual([
      "layout",
      "layout",
      "notFound(layout)",
      "parallel",
    ]);
    expect(metadata.slots?.["@modal"]?.segments?.length).toBe(1);
  });
});
