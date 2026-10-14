/**
 * Audit (dc-t80 point 3): a render whose error the router recovers from must
 * not be stored by any server cache writer and replayed to later visitors.
 * Each writer is driven through serveShellRequest with a first request that
 * fails (recovered by errorBoundary(), a streamed loading() boundary, a loader
 * error, or an async component's Flight error row) and a second request that
 * is healthy: a stored failure shows as the second request serving the
 * declared fallback, or as the handler not running again.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import {
  createLoader,
  createRouter,
  urls,
  type Middleware,
} from "../../index.rsc.js";
import {
  getCachedTree,
  getUpstream,
  state as useCacheState,
} from "./fixtures/cache-writers-failed-render-data.js";
import {
  MemorySegmentCacheStore,
  createDocumentCacheMiddleware,
} from "../../cache/index.js";

let failing = true;
let runs = 0;

const Loading = <p>loading-fallback</p>;
const Declared = <p>declared-error</p>;

const earlyCacheControl: Middleware = async (ctx, next) => {
  ctx.header("Cache-Control", "s-maxage=60, stale-while-revalidate=300");
  await next();
};

/** A handler that throws before it returns: the sync path's errorBoundary(). */
async function Thrown(): Promise<React.ReactNode> {
  runs += 1;
  if (failing) throw new Error("upstream down");
  return <p>healthy-content</p>;
}

/** The same handler, awaited after the response starts (loading()). */
async function Streamed(): Promise<React.ReactNode> {
  runs += 1;
  await new Promise((r) => setTimeout(r, 5));
  if (failing) throw new Error("upstream down");
  return <p>healthy-content</p>;
}

async function BadChild(): Promise<React.ReactNode> {
  if (failing) throw new Error("child down");
  return <i>healthy-child</i>;
}

/** The handler is healthy; an async server component below it fails. */
function WithAsyncChild(): React.ReactNode {
  runs += 1;
  return (
    <section>
      <p>healthy-content</p>
      <BadChild />
    </section>
  );
}

const FlakyLoader = createLoader(async () => {
  if (failing) throw new Error("loader down");
  return { stamp: "loader-ok" };
});

function Plain(): React.ReactNode {
  runs += 1;
  return <p>healthy-content</p>;
}

type Kind = "thrown" | "streamed" | "loader" | "async-child";

const HANDLERS = {
  thrown: Thrown,
  streamed: Streamed,
  loader: Plain,
  "async-child": WithAsyncChild,
} as const;

const KINDS: Kind[] = ["thrown", "streamed", "loader", "async-child"];

/** What the second, healthy request must serve instead of the failure. */
function healthyMarker(kind: Kind): string {
  if (kind === "loader") return "loader-ok";
  if (kind === "async-child") return "healthy-child";
  return "healthy-content";
}

beforeEach(async () => {
  failing = true;
  runs = 0;
  useCacheState.failing = true;
  useCacheState.runs = 0;
  await resetShellTestState();
});

/** The route options a kind needs below its path(): boundary, loading, loader. */
function inner(
  kind: Kind,
  items: {
    loader: (l: typeof FlakyLoader) => never;
    loading: (n: React.ReactNode) => never;
    errorBoundary: (n: React.ReactNode) => never;
  },
): never[] {
  return [
    items.errorBoundary(Declared),
    ...(kind === "streamed" ? [items.loading(Loading)] : []),
    ...(kind === "loader" ? [items.loader(FlakyLoader)] : []),
  ] as never[];
}

/** Date.now moves; timers stay real, so a stale record needs no sleeping. */
function movableClock(): { advance(ms: number): void } {
  const realNow = Date.now.bind(Date);
  let offset = 0;
  vi.spyOn(Date, "now").mockImplementation(() => realNow() + offset);
  return { advance: (ms) => (offset += ms) };
}

const settle = (ms = 80) => new Promise((r) => setTimeout(r, ms));

afterEach(() => {
  vi.restoreAllMocks();
});

describe.each(KINDS)("recovered %s render", (kind) => {
  // The document cache stores a render whose loader failed: the error rides in
  // the body as a settled loader result, not as a Flight or Fizz error, so
  // _renderErrors stays empty (cache/document-cache.ts throwIfRenderErrored).
  // it.fails pins the gap; drop it when the writer refuses.
  const docIt = kind === "loader" ? it.fails : it;

  it("cache(): the next request is healthy", async () => {
    const cacheStore = new MemorySegmentCacheStore();
    const router = createRouter({ cache: { store: cacheStore } }).routes(
      urls(({ path, cache, loader, loading, errorBoundary }) => [
        cache({ ttl: 300 }, () => [
          path("/c", HANDLERS[kind], { name: "c" }, () =>
            inner(kind, { loader, loading, errorBoundary } as never),
          ),
        ]),
      ]),
    );
    await serveShellRequest(router, "/c", { cacheStore });
    failing = false;
    const second = await serveShellRequest(router, "/c", { cacheStore });
    expect(second.flight).toContain(healthyMarker(kind));
    expect(second.flight).not.toContain("declared-error");
  });

  it("cache(), navigation: the next request is healthy", async () => {
    const cacheStore = new MemorySegmentCacheStore();
    const router = createRouter({ cache: { store: cacheStore } }).routes(
      urls(({ path, cache, loader, loading, errorBoundary }) => [
        cache({ ttl: 300 }, () => [
          path("/n", HANDLERS[kind], { name: "n" }, () =>
            inner(kind, { loader, loading, errorBoundary } as never),
          ),
        ]),
      ]),
    );
    const partial = { from: "/" };
    await serveShellRequest(router, "/n", { cacheStore, partial });
    failing = false;
    const second = await serveShellRequest(router, "/n", {
      cacheStore,
      partial,
    });
    expect(second.flight).toContain(healthyMarker(kind));
    expect(second.flight).not.toContain("declared-error");
  });

  it("cache(), stale refresh: a failing refresh does not replace the stale record", async () => {
    const clock = movableClock();
    const cacheStore = new MemorySegmentCacheStore();
    const router = createRouter({ cache: { store: cacheStore } }).routes(
      urls(({ path, cache, loader, loading, errorBoundary }) => [
        cache({ ttl: 1, swr: 300 }, () => [
          path("/s", HANDLERS[kind], { name: "s" }, () =>
            inner(kind, { loader, loading, errorBoundary } as never),
          ),
        ]),
      ]),
    );
    failing = false;
    await serveShellRequest(router, "/s", { cacheStore });
    await settle();
    clock.advance(1_500);
    failing = true;
    runs = 0;
    await serveShellRequest(router, "/s", { cacheStore });
    await settle();
    // The stale record was served and the refresh ran the handler.
    expect(runs).toBe(1);
    failing = false;
    const third = await serveShellRequest(router, "/s", { cacheStore });
    expect(third.flight).toContain(healthyMarker(kind));
    expect(third.flight).not.toContain("declared-error");
  });

  it("ppr: no failed shell is served and the next request is healthy", async () => {
    const cacheStore = new MemorySegmentCacheStore();
    const router = createRouter({ cache: { store: cacheStore } }).routes(
      urls(({ path, loader, loading, errorBoundary }) => [
        path(
          "/p",
          HANDLERS[kind],
          { name: "p", ppr: { ttl: 300, swr: 60 } },
          () => inner(kind, { loader, loading, errorBoundary } as never),
        ),
      ]),
    );
    const first = await serveShellRequest(router, "/p", { cacheStore });
    // A loader error is not in the shell: loaders are live on every HIT.
    if (kind !== "loader") expect(await first.readEntry()).toBeNull();
    failing = false;
    const second = await serveShellRequest(router, "/p", { cacheStore });
    if (kind !== "loader") expect(second.shellStatus).not.toBe("HIT");
    expect(second.flight).toContain(healthyMarker(kind));
    expect(second.flight).not.toContain("declared-error");
  });

  docIt("document cache: the next request is a MISS and healthy", async () => {
    const cacheStore = new MemorySegmentCacheStore();
    const router = createRouter({})
      .use(createDocumentCacheMiddleware())
      .use("/d", earlyCacheControl)
      .routes(
        urls(({ path, loader, loading, errorBoundary }) => [
          path("/d", HANDLERS[kind], { name: "d" }, () =>
            inner(kind, { loader, loading, errorBoundary } as never),
          ),
        ]),
      );
    await serveShellRequest(router, "/d", { cacheStore });
    failing = false;
    const second = await serveShellRequest(router, "/d", { cacheStore });
    expect(second.response.headers.get("x-document-cache-status")).toBe("MISS");
    expect(second.body).not.toContain("declared-error");
  });

  docIt(
    "document cache, stale refresh: a failing refresh does not replace the stale document",
    async () => {
      const clock = movableClock();
      const cacheStore = new MemorySegmentCacheStore();
      const router = createRouter({})
        .use(createDocumentCacheMiddleware())
        .use("/ds", async (ctx, next) => {
          ctx.header("Cache-Control", "s-maxage=1, stale-while-revalidate=300");
          await next();
        })
        .routes(
          urls(({ path, loader, loading, errorBoundary }) => [
            path("/ds", HANDLERS[kind], { name: "ds" }, () =>
              inner(kind, { loader, loading, errorBoundary } as never),
            ),
          ]),
        );
      failing = false;
      await serveShellRequest(router, "/ds", { cacheStore });
      await settle();
      clock.advance(1_500);
      failing = true;
      const stale = await serveShellRequest(router, "/ds", { cacheStore });
      expect(stale.response.headers.get("x-document-cache-status")).toBe(
        "STALE",
      );
      await settle();
      failing = false;
      const third = await serveShellRequest(router, "/ds", { cacheStore });
      expect(third.body).not.toContain("declared-error");
    },
  );
});

describe("recovered failure below a cache that is not a route cache()", () => {
  it('"use cache" function that throws under an errorBoundary(): re-runs when healthy', async () => {
    const cacheStore = new MemorySegmentCacheStore();
    const router = createRouter({}).routes(
      urls(({ path, errorBoundary }) => [
        path(
          "/u",
          async () => <p>{await getUpstream()}</p>,
          { name: "u" },
          () => [errorBoundary(Declared)],
        ),
      ]),
    );
    const opts = { cacheStore, cacheProfiles: { default: { ttl: 300 } } };
    await serveShellRequest(router, "/u", opts);
    await settle();
    useCacheState.failing = false;
    const second = await serveShellRequest(router, "/u", opts);
    expect(second.flight).toContain("healthy-upstream");
    expect(useCacheState.runs).toBe(2);
  });

  it('"use cache" tree with a failing async component: re-runs when healthy', async () => {
    const cacheStore = new MemorySegmentCacheStore();
    const router = createRouter({}).routes(
      urls(({ path, errorBoundary }) => [
        path(
          "/t",
          async () => <main>{await getCachedTree()}</main>,
          { name: "t" },
          () => [errorBoundary(Declared)],
        ),
      ]),
    );
    const opts = { cacheStore, cacheProfiles: { default: { ttl: 300 } } };
    await serveShellRequest(router, "/t", opts);
    await settle();
    useCacheState.failing = false;
    const second = await serveShellRequest(router, "/t", opts);
    expect(second.flight).toContain("healthy-upstream");
    expect(useCacheState.runs).toBe(2);
  });

  it("loader cache(): a loader that throws is not stored", async () => {
    const cacheStore = new MemorySegmentCacheStore();
    const router = createRouter({ cache: { store: cacheStore } }).routes(
      urls(({ path, loader, cache, errorBoundary }) => [
        path("/lc", Plain, { name: "lc" }, () => [
          errorBoundary(Declared),
          loader(FlakyLoader, () => [cache({ ttl: 300 })]),
        ]),
      ]),
    );
    await serveShellRequest(router, "/lc", { cacheStore });
    await settle();
    failing = false;
    const second = await serveShellRequest(router, "/lc", { cacheStore });
    expect(second.flight).toContain("loader-ok");
  });

  it("loader cache(): a loader whose value holds a rejected promise is not stored", async () => {
    const cacheStore = new MemorySegmentCacheStore();
    const LateLoader = createLoader(async () => {
      const later = failing
        ? Promise.reject(new Error("late down"))
        : Promise.resolve("loader-late-ok");
      later.catch(() => {});
      return { later };
    });
    const router = createRouter({ cache: { store: cacheStore } }).routes(
      urls(({ path, loader, cache, errorBoundary }) => [
        path("/ll", Plain, { name: "ll" }, () => [
          errorBoundary(Declared),
          loader(LateLoader, () => [cache({ ttl: 300 })]),
        ]),
      ]),
    );
    await serveShellRequest(router, "/ll", { cacheStore });
    await settle();
    failing = false;
    const second = await serveShellRequest(router, "/ll", { cacheStore });
    expect(second.flight).toContain("loader-late-ok");
  });
});

describe.each(KINDS)(
  "router.prerender() warm of a recovered %s render",
  (kind) => {
    const ORIGIN = "http://localhost";

    it("cache(): the warm does not store the failure", async () => {
      const cacheStore = new MemorySegmentCacheStore({ scope: "global" });
      const router = createRouter({ cache: { store: cacheStore } }).routes(
        urls(({ path, cache, loader, loading, errorBoundary }) => [
          cache({ ttl: 300 }, () => [
            path("/wc", HANDLERS[kind], { name: "wc" }, () =>
              inner(kind, { loader, loading, errorBoundary } as never),
            ),
          ]),
        ]),
      );
      const result = await router.prerender({ env: {} })(`${ORIGIN}/wc`);
      await settle();
      failing = false;
      const next = await serveShellRequest(router, "/wc", { cacheStore });
      expect(next.flight).toContain(healthyMarker(kind));
      expect(next.flight).not.toContain("declared-error");
      // Loader errors are not a recovered render the warm can see.
      if (kind !== "loader") expect(result).toMatchObject({ ok: false });
    });

    it("ppr: the warm does not store a failed shell", async () => {
      const cacheStore = new MemorySegmentCacheStore({ scope: "global" });
      const router = createRouter({ cache: { store: cacheStore } }).routes(
        urls(({ path, loader, loading, errorBoundary }) => [
          path(
            "/wp",
            HANDLERS[kind],
            { name: "wp", ppr: { ttl: 300, swr: 60 } },
            () => inner(kind, { loader, loading, errorBoundary } as never),
          ),
        ]),
      );
      await router.prerender({ env: {} })(`${ORIGIN}/wp`);
      await settle();
      failing = false;
      const next = await serveShellRequest(router, "/wp", { cacheStore });
      if (kind !== "loader") expect(next.shellStatus).not.toBe("HIT");
      expect(next.flight).toContain(healthyMarker(kind));
      expect(next.flight).not.toContain("declared-error");
    });
  },
);
