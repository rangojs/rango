/**
 * Issue #957: a ppr route's cache() record carries the tags its covered
 * content recorded with the render-callable cacheTag(), so a shell captured
 * by replaying that record is tagged, and updateTag() of such a tag drops
 * the record as well as the shell.
 *
 * Runs the real serve pipeline with real Flight (the prune suite's harness):
 * a MISS renders the foreground, which writes the route's cache() record;
 * the capture it schedules settles that write first (the write barrier in
 * shell-capture.ts) and replays the record, so the layout does not run again
 * inside the capture. Only the SSR half is stubbed.
 *
 * A HIT replays handler output from the record, loading() subtrees included,
 * so the @side slot's handler, the component it returns, and the loader it
 * consumes all tag the record. A loader's tags reach the record only through
 * a handler that consumes it: @live's loader, read by nothing on the server
 * (a client useLoader under loading()), stays off.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { AsyncLocalStorage } from "node:async_hooks";

vi.mock(
  "@vitejs/plugin-rsc/rsc/server",
  () => import("../../testing/vitest-stubs/plugin-rsc.js"),
);
vi.mock(
  "@vitejs/plugin-rsc/rsc/client",
  () => import("../../testing/vitest-stubs/plugin-rsc.js"),
);
vi.mock("../../prerender/store.js", () => ({
  createPrerenderStore: () => ({ get: async () => null }),
}));

import { renderToReadableStream } from "../../testing/vitest-stubs/plugin-rsc.js";
import { createRouter } from "../../router.js";
import { createLoader } from "../../loader.rsc.js";
import { cacheTag } from "../../cache/cache-tag.js";
import { createHandle } from "../../handle.js";
import { buildRouterTrieFromUrlpatterns } from "../manifest-init.js";
import { handleRscRendering } from "../rsc-rendering.js";
import { MemorySegmentCacheStore } from "../../cache/memory-segment-store.js";
import { shellCacheKey } from "../../testing/shell-status.js";
import { CFCacheStore } from "../../cache/cf/cf-cache-store.js";
import type { CachedEntryData, SegmentCacheStore } from "../../cache/types.js";
import {
  createRequestContext,
  getRequestContext,
  runWithRequestContext,
  setRequestContextParams,
  type ExecutionContext,
  type RequestContext,
} from "../../server/request-context.js";
import {
  classifyRequest,
  type ClassifyRequestDeps,
} from "../../router/request-classification.js";
import type { HandlerContext } from "../handler-context.js";
import type { RscPayload, SSRModule } from "../types.js";
import type { PartialCacheOptions } from "../../types.js";

const LAYOUT_TAG = "layout-tag";
const ASYNC_TAG = "async-component-tag";
const OWN_LOADER_TAG = "layout-own-loader-tag";
const SLOT_HANDLER_TAG = "slot-handler-tag";
const SLOT_RENDER_TAG = "slot-render-tag";
const SLOT_LOADER_TAG = "slot-loader-tag";
const UNCONSUMED_LOADER_TAG = "unconsumed-loader-tag";
const HANDLE_TAG = "handle-render-tag";
const ROUTE_CONFIG_TAG = "route-config-tag";

const PRELUDE = "<html><body>FROZEN-PRELUDE</body></html>";

const ssrModule = {
  async renderHTML(rscStream: ReadableStream<Uint8Array>) {
    await new Response(rscStream).text();
    return new Response("<html><body>AXIS-1</body></html>").body!;
  },
  async resumeShellHTML(rscStream: ReadableStream<Uint8Array>) {
    return rscStream;
  },
  async captureShellHTML(
    rscStream: ReadableStream<Uint8Array>,
    options: { quiesce: Promise<unknown> },
  ) {
    const reader = rscStream.getReader();
    void (async () => {
      for (;;) {
        const { done } = await reader.read();
        if (done) return;
      }
    })();
    await options.quiesce;
    return { prelude: new TextEncoder().encode(PRELUDE), postponed: null };
  },
} as unknown as SSRModule;

type Router = ReturnType<typeof createRouter>;

const calls = { layout: 0 };

function taggingLoader(id: string, tag: string): unknown {
  return (createLoader as Function)(
    async () => {
      cacheTag(tag);
      return { tag };
    },
    undefined,
    `test#RecordTags${id}`,
  );
}
// Started by the DSL funnel before the layout handler runs; the handler
// consumes it.
const OwnLoader = taggingLoader("OwnLoader", OWN_LOADER_TAG);
// Started by the slot handler's own ctx.use (slots resolve before their
// loaders).
const SlotLoader = taggingLoader("SlotLoader", SLOT_LOADER_TAG);
// Read by nothing on the server.
const UnconsumedLoader = taggingLoader(
  "UnconsumedLoader",
  UNCONSUMED_LOADER_TAG,
);

type UseCtx = { use: (item: unknown) => any };

const Crumbs = createHandle<unknown>(undefined, "test#RecordTagsCrumbs");

// A handle value is replayed from the record on a HIT, like segment output.
async function HandleTagger(): Promise<React.ReactNode> {
  await Promise.resolve();
  cacheTag(HANDLE_TAG);
  return <span>crumb</span>;
}

// Shell material recorded after an await, at render time (the #676 shape).
async function AsyncTagger(): Promise<null> {
  await Promise.resolve();
  cacheTag(ASYNC_TAG);
  return null;
}

// Rendered from the loading() slot's handler output.
async function SlotContent(): Promise<React.ReactNode> {
  await Promise.resolve();
  cacheTag(SLOT_RENDER_TAG);
  return <p>slot</p>;
}

async function TagLayout(ctx: UseCtx): Promise<React.ReactNode> {
  calls.layout++;
  cacheTag(LAYOUT_TAG);
  await ctx.use(OwnLoader);
  ctx.use(Crumbs)(<HandleTagger />);
  return (
    <main data-generation={calls.layout}>
      <AsyncTagger />
    </main>
  );
}

async function SideSlot(ctx: UseCtx): Promise<React.ReactNode> {
  cacheTag(SLOT_HANDLER_TAG);
  await ctx.use(SlotLoader);
  return <SlotContent />;
}

async function makeRouter(
  withCache: boolean | PartialCacheOptions = true,
): Promise<Router> {
  const router = createRouter({} as any);
  router.routes(({ layout, parallel, loader, loading, cache, path }: any) => {
    const page = () =>
      path("/tagged", () => <p>page</p>, {
        name: "recordTagsPage",
        ppr: { ttl: 300 },
      });
    return [
      layout(TagLayout, () => [
        loader(OwnLoader),
        parallel({ "@side": SideSlot }, () => [
          loader(SlotLoader),
          loading(<p>side skeleton</p>),
        ]),
        parallel({ "@live": () => <p>live slot</p> }, () => [
          loader(UnconsumedLoader),
          loading(<p>live skeleton</p>),
        ]),
        withCache
          ? cache(withCache === true ? { ttl: 60 } : withCache, () => [page()])
          : page(),
      ]),
    ];
  });
  await buildRouterTrieFromUrlpatterns(router);
  return router;
}

function makeCtx(router: Router): HandlerContext<unknown> {
  return {
    version: "v-record-tags",
    router,
    callOnError: vi.fn(),
    renderToReadableStream: (payload: RscPayload, options?: object) =>
      renderToReadableStream(payload, options),
    loadSSRModule: async () => ssrModule,
    resolveStreamMode: async () => "stream",
  } as unknown as HandlerContext<unknown>;
}

/** The execution context's waitUntil tasks (a CFCacheStore's included). */
const backgroundTasks: Promise<unknown>[] = [];
const executionContext = {
  waitUntil: (task: Promise<unknown>) => {
    backgroundTasks.push(task);
  },
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

/**
 * Serve one document request through handleRscRendering and settle every
 * background task it scheduled, the MISS's capture included. waitUntil keeps
 * its production wiring (tracked on the request context, forwarded to the
 * execution context), so the capture's write barrier sees the foreground's
 * cache() record write.
 */
async function serve(
  router: Router,
  store: SegmentCacheStore,
  path: string,
): Promise<Response> {
  const url = new URL(`http://localhost${path}`);
  const request = new Request(url, { headers: { accept: "text/html" } });
  const reqCtx = createRequestContext({
    env: {},
    request,
    url,
    variables: {},
    cacheStore: store,
    cacheProfiles: { default: { ttl: 300 } },
    executionContext,
  }) as RequestContext<unknown>;
  const ctx = makeCtx(router);
  // As rsc/handler.ts does: the cache keys carry the serving router.
  reqCtx._routerId = router.id;
  const response = await runWithRequestContext(reqCtx, async () => {
    const plan = await classifyRequest(request, url, {
      findMatch: (router as unknown as ClassifyRequestDeps).findMatch,
      routerVersion: ctx.version,
      routerId: router.id,
    });
    if (plan.mode !== "full-render") {
      throw new Error(`unexpected request plan ${plan.mode}`);
    }
    setRequestContextParams(plan.route.params, plan.route.routeKey);
    reqCtx._classifiedRoute = plan.route;
    return handleRscRendering(
      ctx,
      request,
      {},
      url,
      false,
      reqCtx._handleStore,
      undefined,
    );
  });
  await new Response(response.body).text();
  while (backgroundTasks.length > 0) {
    await Promise.allSettled(backgroundTasks.splice(0));
  }
  return response;
}

const shellKey = (router: Router): string => shellCacheKey(router, "/tagged");

/** The tags the store's one shell entry (/tagged) is invalidatable by. */
function shellTags(store: MemorySegmentCacheStore): string[] {
  const shells = (
    store as unknown as { shellCache: Map<string, { tags?: string[] }> }
  ).shellCache;
  const [entry, ...others] = [...shells.values()];
  if (!entry || others.length > 0) {
    throw new Error(`expected one shell stored, found ${shells.size}`);
  }
  return entry.tags ?? [];
}

describe("PPR capture over the route's cache() record (#957)", () => {
  let router: Router;
  let store: MemorySegmentCacheStore;
  let recordTags: Array<string[] | undefined>;

  beforeEach(async () => {
    calls.layout = 0;
    router = await makeRouter();
    store = new MemorySegmentCacheStore();
    recordTags = [];
    const set = store.set.bind(store);
    store.set = async (key: string, data: CachedEntryData, ...rest) => {
      recordTags.push(data.tags);
      return set(key, data, ...rest);
    };
  });

  it("the capture replays the record and the shell carries the render-called tags", async () => {
    const miss = await serve(router, store, "/tagged");
    expect(miss.headers.get("x-rango-shell")).toBe("MISS");

    // The foreground ran the layout; the capture replayed the record.
    expect(calls.layout).toBe(1);
    const tags = shellTags(store);
    expect(tags).toContain(LAYOUT_TAG);
    expect(tags).toContain(ASYNC_TAG);
  });

  it("a loader the layout consumes tags the record and the shell, though the DSL started it", async () => {
    await serve(router, store, "/tagged");

    expect(recordTags).toHaveLength(1);
    expect(recordTags[0] ?? []).toContain(OWN_LOADER_TAG);
    expect(shellTags(store)).toContain(OWN_LOADER_TAG);
  });

  it("a loading() slot's handler output, its component and the loader it consumes tag the record and the shell", async () => {
    await serve(router, store, "/tagged");

    const slotTags = [SLOT_HANDLER_TAG, SLOT_RENDER_TAG, SLOT_LOADER_TAG];
    expect(recordTags[0] ?? []).toEqual(expect.arrayContaining(slotTags));
    expect(shellTags(store)).toEqual(expect.arrayContaining(slotTags));
  });

  it("a loader no handler consumes stays off the record and the shell", async () => {
    await serve(router, store, "/tagged");

    expect(recordTags[0] ?? []).not.toContain(UNCONSUMED_LOADER_TAG);
    expect(shellTags(store)).not.toContain(UNCONSUMED_LOADER_TAG);
  });

  it("a render-time tag inside a handle value tags the record and the shell", async () => {
    await serve(router, store, "/tagged");

    expect(recordTags[0] ?? []).toContain(HANDLE_TAG);
    expect(shellTags(store)).toContain(HANDLE_TAG);
  });

  it.each([
    ["a handler-time tag", LAYOUT_TAG],
    ["a render-time tag recorded after an await", ASYNC_TAG],
    ["a tag of a loader the layout consumes", OWN_LOADER_TAG],
    ["a render-time tag inside a handle value", HANDLE_TAG],
  ])(
    "updateTag of %s drops shell and record; the recapture renders fresh and is tagged again",
    async (_label, tag) => {
      await serve(router, store, "/tagged");
      expect(calls.layout).toBe(1);

      await store.invalidateTags([tag]);
      expect(await store.getShell(shellKey(router))).toBeNull();

      const again = await serve(router, store, "/tagged");
      expect(again.headers.get("x-rango-shell")).toBe("MISS");
      // The record was dropped with the shell: the layout rendered fresh.
      expect(calls.layout).toBe(2);
      expect(shellTags(store)).toContain(tag);

      // The second generation is evictable too.
      await store.invalidateTags([tag]);
      expect(await store.getShell(shellKey(router))).toBeNull();
    },
  );
});

// The shell's tags are its doc record's (plus bake-lane loaders' and
// ppr.tags), so a capture that rendered the page fresh and one that replayed
// the route's cache() record agree, and a tag recorded on the request outside
// the record cannot reach the shell.
describe("PPR capture tags without a route cache(): the doc record's tags", () => {
  beforeEach(() => {
    calls.layout = 0;
  });

  it("a fresh capture stores the same shell tags as a capture that replays the route's record", async () => {
    const fresh = new MemorySegmentCacheStore();
    await serve(await makeRouter(false), fresh, "/tagged");
    // No record to replay: the foreground and the capture both ran the layout.
    expect(calls.layout).toBe(2);

    const replay = new MemorySegmentCacheStore();
    await serve(await makeRouter(true), replay, "/tagged");

    expect(new Set(shellTags(fresh))).toEqual(new Set(shellTags(replay)));
    expect(shellTags(fresh)).toEqual(
      expect.arrayContaining([
        LAYOUT_TAG,
        ASYNC_TAG,
        OWN_LOADER_TAG,
        SLOT_HANDLER_TAG,
        SLOT_RENDER_TAG,
        SLOT_LOADER_TAG,
        HANDLE_TAG,
      ]),
    );
    expect(shellTags(fresh)).not.toContain(UNCONSUMED_LOADER_TAG);
  });

  it.each([
    ["replays the route's record", undefined],
    [
      "renders fresh (the route's store never holds its record)",
      Object.assign(new MemorySegmentCacheStore(), { set: async () => {} }),
    ],
  ])(
    "the route cache()'s own tags are on the shell whether the capture %s",
    async (_label, routeStore) => {
      const store = new MemorySegmentCacheStore();
      await serve(
        await makeRouter({
          ttl: 60,
          tags: [ROUTE_CONFIG_TAG],
          ...(routeStore ? { store: routeStore } : {}),
        }),
        store,
        "/tagged",
      );
      expect(calls.layout).toBe(routeStore ? 2 : 1);
      expect(shellTags(store)).toEqual(
        expect.arrayContaining([ROUTE_CONFIG_TAG, LAYOUT_TAG]),
      );
    },
  );
});

describe("record tag owners run only where a record can be written (#957)", () => {
  /** Segment tag scopes entered (their async-local store is an "s:" key). */
  function segmentScopeRuns(run: { mock: { calls: unknown[][] } }): number {
    return run.mock.calls.filter(
      ([store]) => typeof store === "string" && store.startsWith("s:"),
    ).length;
  }

  function recordWrites(store: MemorySegmentCacheStore): string[][] {
    const writes: string[][] = [];
    const set = store.set.bind(store);
    store.set = async (key: string, data: CachedEntryData, ...rest) => {
      writes.push(data.tags ?? []);
      return set(key, data, ...rest);
    };
    return writes;
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("a route with no cache(), ppr or document cache writes no record and enters no tag scope", async () => {
    const router = createRouter({} as any);
    router.routes(({ layout, path }: any) => [
      layout(
        async (ctx: UseCtx) => {
          cacheTag("plain-layout-tag");
          await ctx.use(OwnLoader);
          return <main>plain</main>;
        },
        () => [path("/plain", () => <p>page</p>, { name: "recordTagsPlain" })],
      ),
    ]);
    await buildRouterTrieFromUrlpatterns(router);
    const store = new MemorySegmentCacheStore();
    const writes = recordWrites(store);
    const run = vi.spyOn(AsyncLocalStorage.prototype, "run");

    await serve(router, store, "/plain");

    expect(writes).toEqual([]);
    expect(segmentScopeRuns(run)).toBe(0);
  });

  it("control: the ppr route with a cache() enters segment tag scopes", async () => {
    const router = await makeRouter();
    const store = new MemorySegmentCacheStore();
    const run = vi.spyOn(AsyncLocalStorage.prototype, "run");

    await serve(router, store, "/tagged");

    expect(segmentScopeRuns(run)).toBeGreaterThan(0);
  });

  it("a document HIT tail arms no tag owners: it replays the doc record and writes none", async () => {
    // A live loader runs in every request's render, the HIT tail's included,
    // and reads whether its context records tag owners.
    const armed: Array<boolean | undefined> = [];
    const ProbeLoader = (createLoader as Function)(
      async () => {
        armed.push(getRequestContext()._recordTagOwners);
        return { ok: true };
      },
      undefined,
      "test#RecordTagsProbe",
    );
    const router = createRouter({} as any);
    router.routes(({ layout, loader, loading, cache, path }: any) => [
      layout(
        () => <main>probe</main>,
        () => [
          loader(ProbeLoader),
          loading(<p>probe skeleton</p>),
          cache({ ttl: 60 }, () => [
            path("/probe", () => <p>page</p>, {
              name: "recordTagsProbe",
              ppr: { ttl: 300 },
            }),
          ]),
        ],
      ),
    ]);
    await buildRouterTrieFromUrlpatterns(router);
    const store = new MemorySegmentCacheStore();
    await serve(router, store, "/probe");
    // The MISS render resolved the route's cache() scope and armed.
    expect(armed).toEqual([true]);
    const writes = recordWrites(store);

    const hit = await serve(router, store, "/probe");

    expect(hit.headers.get("x-rango-shell")).toBe("HIT");
    expect(armed).toHaveLength(2);
    expect(armed[1]).not.toBe(true);
    expect(writes).toEqual([]);
  });

  it("a stale record's background rewrite keeps its tags (the derived context inherits the flag)", async () => {
    const SwrLoader = taggingLoader("SwrLoader", "swr-loader-tag");
    const router = createRouter({} as any);
    router.routes(({ layout, cache, path, loader }: any) => [
      cache({ ttl: 60, swr: 60 }, () => [
        layout(
          async (ctx: UseCtx) => {
            cacheTag("swr-layout-tag");
            await ctx.use(SwrLoader);
            return (
              <main>
                <AsyncTagger />
              </main>
            );
          },
          () => [
            loader(SwrLoader),
            path("/swr", () => <p>page</p>, { name: "recordTagsSwr" }),
          ],
        ),
      ]),
    ]);
    await buildRouterTrieFromUrlpatterns(router);
    const store = new MemorySegmentCacheStore();
    const writes = recordWrites(store);

    await serve(router, store, "/swr");
    // Serve the record stale once: the HIT schedules the background rewrite.
    const get = store.get.bind(store);
    let staled = false;
    store.get = async (key: string) => {
      const hit = await get(key);
      if (staled || !hit || !("data" in hit)) return hit;
      staled = true;
      return { ...hit, shouldRevalidate: true };
    };
    await serve(router, store, "/swr");

    expect(staled).toBe(true);
    expect(writes).toHaveLength(2);
    for (const tags of writes) {
      expect(tags).toEqual(
        expect.arrayContaining(["swr-layout-tag", ASYNC_TAG, "swr-loader-tag"]),
      );
    }
  });
});

describe("the capture's write barrier over CFCacheStore (#957)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("replays the foreground's cache() record even when its Cache API put lands late", async () => {
    calls.layout = 0;
    const router = await makeRouter();
    const stored = new Map<string, { body: string; init: ResponseInit }>();
    const cache = {
      async match(request: Request): Promise<Response | undefined> {
        const hit = stored.get(request.url);
        return hit ? new Response(hit.body, hit.init) : undefined;
      },
      async put(request: Request, response: Response): Promise<void> {
        const body = await response.text();
        await new Promise((resolve) => setTimeout(resolve, 20));
        stored.set(request.url, {
          body,
          init: { status: response.status, headers: response.headers },
        });
      },
      async delete(request: Request): Promise<boolean> {
        return stored.delete(request.url);
      },
    };
    vi.stubGlobal("caches", { default: cache, open: async () => cache });
    // KV-less: the Cache API put is the only copy the capture can read. A
    // tagged KV-less shell warns that tags cannot evict it; not under test.
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = new CFCacheStore({ ctx: executionContext });

    const miss = await serve(router, store, "/tagged");

    expect(miss.headers.get("x-rango-shell")).toBe("MISS");
    // The capture read the foreground's record instead of rendering again.
    expect(calls.layout).toBe(1);
  });
});
