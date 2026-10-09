/**
 * A streamed handler recovered into its declared boundary resolves, so Flight
 * reports no error and the writers that refuse a failed render through Flight
 * errors would store the fallback as the handler's real output. Each writer
 * must refuse (cache(), the PPR shell, the document cache), and the next
 * request renders healthy content. Also: a slot with loading() finds a boundary
 * declared on an ancestor, as the sync path does.
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
import { createRouter, urls, type Middleware } from "../../index.rsc.js";
import {
  MemorySegmentCacheStore,
  createDocumentCacheMiddleware,
} from "../../cache/index.js";

let failing = true;
let runs = 0;

async function Flaky(): Promise<React.ReactNode> {
  runs += 1;
  await new Promise((r) => setTimeout(r, 5));
  if (failing) throw new Error("upstream down");
  return <p>healthy-content</p>;
}

/** Fails on its first run only: the foreground render, not the capture. */
async function FlakyOnce(): Promise<React.ReactNode> {
  runs += 1;
  if (runs === 1) throw new Error("first run only");
  await new Promise((r) => setTimeout(r, 5));
  return <p>healthy-content</p>;
}

const Loading = <p>loading-fallback</p>;
const Declared = <p>declared-error</p>;

const earlyCacheControl: Middleware = async (ctx, next) => {
  ctx.header("Cache-Control", "s-maxage=60, stale-while-revalidate=300");
  await next();
};

beforeEach(async () => {
  failing = true;
  runs = 0;
  await resetShellTestState();
});

describe("a recovered streamed handler is never stored", () => {
  it("cache(): the next request is healthy and re-runs the handler", async () => {
    const cacheStore = new MemorySegmentCacheStore();
    const router = createRouter({ cache: { store: cacheStore } }).routes(
      urls(({ path, cache, loading, errorBoundary }) => [
        cache({ ttl: 300 }, () => [
          path("/c", Flaky, { name: "c" }, () => [
            loading(Loading),
            errorBoundary(Declared),
          ]),
        ]),
      ]),
    );

    const first = await serveShellRequest(router, "/c", { cacheStore });
    expect(first.flight).toContain("declared-error");

    failing = false;
    const second = await serveShellRequest(router, "/c", { cacheStore });
    expect(second.flight).toContain("healthy-content");
    expect(second.flight).not.toContain("declared-error");
    expect(runs).toBe(2);
  });

  it("ppr: no shell is stored, the next request is healthy", async () => {
    const cacheStore = new MemorySegmentCacheStore();
    const router = createRouter({ cache: { store: cacheStore } }).routes(
      urls(({ path, loading, errorBoundary }) => [
        path("/p", Flaky, { name: "p", ppr: { ttl: 300, swr: 60 } }, () => [
          loading(Loading),
          errorBoundary(Declared),
        ]),
      ]),
    );

    const first = await serveShellRequest(router, "/p", { cacheStore });
    expect(first.flight).toContain("declared-error");
    expect(await first.readEntry()).toBeNull();

    failing = false;
    const second = await serveShellRequest(router, "/p", { cacheStore });
    expect(second.shellStatus).not.toBe("HIT");
    expect(second.flight).toContain("healthy-content");
    expect(second.flight).not.toContain("declared-error");
  });

  it("ppr: a foreground failure does not refuse the healthy capture that follows", async () => {
    const cacheStore = new MemorySegmentCacheStore();
    const router = createRouter({ cache: { store: cacheStore } }).routes(
      urls(({ path, loading, errorBoundary }) => [
        path("/o", FlakyOnce, { name: "o", ppr: { ttl: 300, swr: 60 } }, () => [
          loading(Loading),
          errorBoundary(Declared),
        ]),
      ]),
    );

    const first = await serveShellRequest(router, "/o", { cacheStore });
    expect(runs).toBe(2);
    const entry = await first.readEntry();
    expect(entry).not.toBeNull();
    expect(JSON.stringify(entry)).toContain("healthy-content");
  });

  it("document cache: the next request is a MISS with healthy content", async () => {
    const cacheStore = new MemorySegmentCacheStore();
    const router = createRouter({})
      .use(createDocumentCacheMiddleware())
      .use("/d", earlyCacheControl)
      .routes(
        urls(({ path, loading, errorBoundary }) => [
          path("/d", Flaky, { name: "d" }, () => [
            loading(Loading),
            errorBoundary(Declared),
          ]),
        ]),
      );

    const first = await serveShellRequest(router, "/d", { cacheStore });
    expect(first.body).toContain("declared-error");
    expect(first.response.headers.get("x-document-cache-status")).toBe("MISS");

    failing = false;
    const second = await serveShellRequest(router, "/d", { cacheStore });
    expect(second.response.headers.get("x-document-cache-status")).toBe("MISS");
    expect(second.body).toContain("healthy-content");
    expect(second.body).not.toContain("declared-error");
  });
});

describe("a recovered failure refuses only the cache scope that holds it", () => {
  it("a healthy cache() below a layout whose slot recovers is still stored", async () => {
    let healthyRuns = 0;
    const cacheStore = new MemorySegmentCacheStore();
    const router = createRouter({ cache: { store: cacheStore } }).routes(
      urls(({ path, layout, parallel, cache, loading, errorBoundary }) => [
        layout(
          () => <main>shell</main>,
          () => [
            errorBoundary(<p>layout-fallback</p>),
            parallel({ "@side": Flaky }, () => [loading(Loading)]),
            cache({ ttl: 300 }, () => [
              path("/healthy", () => <p>{`healthy-${++healthyRuns}`}</p>, {
                name: "healthy",
              }),
            ]),
          ],
        ),
      ]),
    );

    const first = await serveShellRequest(router, "/healthy", { cacheStore });
    expect(first.flight).toContain("layout-fallback");
    await serveShellRequest(router, "/healthy", { cacheStore });
    expect(healthyRuns).toBe(1);
  });
});

describe("a slot owned by a routeless layout picks the sync path's boundary", () => {
  const owned = (streamed: boolean) =>
    createRouter({}).routes(
      urls(({ path, layout, parallel, loading, errorBoundary }) => [
        layout(
          () => <main>outer</main>,
          () => [
            errorBoundary(<p>outer-fallback</p>),
            // No route inside: an orphan of the outer layout.
            layout(
              () => <section>inner</section>,
              () => [
                errorBoundary(<p>inner-fallback</p>),
                parallel({ "@side": Flaky }, () =>
                  streamed ? [loading(Loading)] : [],
                ),
              ],
            ),
            path("/x", () => <p>page</p>, { name: "x" }),
          ],
        ),
      ]),
    );

  it.each([
    ["document", undefined],
    ["navigation", { from: "/" }],
  ] as const)(
    "%s: streamed and sync render the same fallback",
    async (_, partial) => {
      const sync = await serveShellRequest(owned(false), "/x", {
        cacheStore: new MemorySegmentCacheStore(),
        partial,
      });
      const streamed = await serveShellRequest(owned(true), "/x", {
        cacheStore: new MemorySegmentCacheStore(),
        partial,
      });
      for (const marker of ["outer-fallback", "inner-fallback"]) {
        expect(streamed.flight?.includes(marker)).toBe(
          sync.flight?.includes(marker),
        );
      }
      expect(
        sync.flight?.includes("outer-fallback") ||
          sync.flight?.includes("inner-fallback"),
      ).toBe(true);
    },
  );
});

describe("a slot with loading() finds an ancestor boundary", () => {
  const router = createRouter({}).routes(
    urls(({ path, layout, parallel, loading, errorBoundary }) => [
      layout(
        () => <main>shell</main>,
        () => [
          errorBoundary(<p>ancestor-fallback</p>),
          parallel({ "@side": Flaky }, () => [loading(<p>side-loading</p>)]),
          path("/s", () => <p>page</p>, { name: "s" }),
        ],
      ),
    ]),
  );

  it("document", async () => {
    const res = await serveShellRequest(router, "/s", {
      cacheStore: new MemorySegmentCacheStore(),
    });
    expect(res.flight).toContain("ancestor-fallback");
  });

  it("navigation", async () => {
    const res = await serveShellRequest(router, "/s", {
      cacheStore: new MemorySegmentCacheStore(),
      partial: { from: "/" },
    });
    expect(res.flight).toContain("ancestor-fallback");
  });
});
