/**
 * Handle pushes from a loader with its own cache (`loader(Def, () =>
 * [cache({...})])`) through the real segment funnel: resolveLoaders ->
 * resolveLoaderData -> executeLoaderData -> the real setupLoaderAccess
 * executor -> the request's HandleStore.
 *
 * A loader-cache HIT skips the loader body, so the body's
 * `ctx.use(Handle)(...)` pushes must come from the entry: captured on the
 * MISS, replayed on the HIT into the loader's owning segment.
 */
import { describe, it, expect, vi } from "vitest";

// segment-codec pulls @vitejs/plugin-rsc (unresolvable in plain vitest). A
// JSON codec stands in for Flight on both the value and the handle blob.
vi.mock("../../../cache/segment-codec.js", () => ({
  serializeResult: vi.fn(async (value: unknown) => JSON.stringify(value)),
  deserializeResult: vi.fn(async (encoded: string) => JSON.parse(encoded)),
}));
// handle-snapshot reaches segment-codec through a lazy import(). Vitest 4
// rejects the second of two CONCURRENT import()s of a factory-mocked module
// (falls through to the native loader), and the stale path decodes in the
// foreground while the background revalidation encodes. Same JSON codec,
// without the lazy import.
vi.mock("../../../cache/handle-snapshot.js", async (importActual) => ({
  ...(await importActual<object>()),
  encodeHandles: async (handles: Record<string, Record<string, unknown[]>>) =>
    Object.values(handles).some((h) => Object.keys(h).length > 0)
      ? JSON.stringify(handles)
      : "",
  decodeHandles: async (encoded: string) => JSON.parse(encoded),
}));

import { resolveLoaders } from "../fresh.js";
import { setupLoaderAccess } from "../../loader-resolution.js";
import { createHandlerContext } from "../../handler-context.js";
import {
  createRequestContext,
  runWithRequestContext,
} from "../../../server/request-context.js";
import { MemorySegmentCacheStore } from "../../../cache/memory-segment-store.js";
import { createHandle } from "../../../handle.js";
import type { EntryData, LoaderEntry } from "../../../server/context.js";
import type { LoaderContext, LoaderDefinition } from "../../../types.js";
import type { SegmentResolutionDeps } from "../../types.js";

const Meta = createHandle<{ title: string }>();
const Crumbs = createHandle<{ label: string }>();

const deps = {
  wrapLoaderPromise: (p: Promise<unknown>) => p,
} as unknown as SegmentResolutionDeps<any>;

function defineLoader(
  id: string,
  fn: (ctx: LoaderContext<any, any>) => Promise<unknown>,
): LoaderDefinition<any, any> & { calls: number } {
  const def = {
    __brand: "loader" as const,
    $$id: id,
    calls: 0,
    fn: (ctx: LoaderContext<any, any>) => {
      def.calls++;
      return fn(ctx);
    },
  };
  return def;
}

function entryWith(loaderEntries: LoaderEntry[]): EntryData {
  return {
    id: "route-product",
    shortCode: "R0",
    type: "route",
    loader: loaderEntries,
    // Loading-disabled: resolveLoaders awaits every loader before returning.
    loading: false,
  } as unknown as EntryData;
}

function cachedEntry(
  loader: LoaderDefinition<any, any>,
  store: MemorySegmentCacheStore,
  options: Record<string, unknown> = {},
): LoaderEntry {
  return {
    loader,
    revalidate: [],
    cache: { options: { store, ttl: 60, ...options } },
  } as LoaderEntry;
}

/**
 * One request through the segment funnel. Returns the handle data the
 * request's store holds for the owning segment after every loader settled
 * and the deferred cache write flushed.
 */
async function runRequest(
  entry: EntryData,
  opts: {
    beforeLoaders?: (reqCtx: any) => void;
    whileLoading?: (reqCtx: any) => void | Promise<void>;
    afterLoaders?: () => void;
  } = {},
) {
  const request = new Request("http://localhost/product");
  const url = new URL(request.url);
  const reqCtx = createRequestContext({
    env: {},
    request,
    url,
    variables: {},
  });
  const data = await runWithRequestContext(reqCtx, async () => {
    const ctx = createHandlerContext(
      {},
      request,
      url.searchParams,
      url.pathname,
      url,
      {},
    );
    setupLoaderAccess(ctx, new Map());
    opts.beforeLoaders?.(reqCtx);
    const resolution = resolveLoaders(entry, ctx, true, deps);
    await opts.whileLoading?.(reqCtx);
    const segments = await resolution;
    const values = await Promise.all(segments.map((s) => s.loaderData));
    opts.afterLoaders?.();
    // Deferred cache writes (and any stale revalidation) ride waitUntil.
    await Promise.all(reqCtx._pendingBackgroundTasks ?? []);
    return values;
  });
  return {
    data,
    handles: reqCtx._handleStore.getDataForSegment("R0"),
    reqCtx,
  };
}

describe("loader-level cache: handle pushes", () => {
  it("replays the loader body's handle push on a loader-cache HIT", async () => {
    const store = new MemorySegmentCacheStore();
    const loader = defineLoader("ProductLoader#L", async (ctx) => {
      ctx.use(Meta)({ title: "Widget" });
      return { name: "Widget" };
    });
    const entry = entryWith([cachedEntry(loader, store)]);

    const miss = await runRequest(entry);
    expect(loader.calls).toBe(1);
    expect(miss.handles[Meta.$$id]).toEqual([{ title: "Widget" }]);

    const hit = await runRequest(entry);
    expect(loader.calls).toBe(1);
    expect(hit.data).toEqual([{ name: "Widget" }]);
    expect(hit.handles[Meta.$$id]).toEqual([{ title: "Widget" }]);
  });

  it("replays every recorded push in order, appended after the segment's other pushes", async () => {
    const store = new MemorySegmentCacheStore();
    const loader = defineLoader("ProductLoader#L", async (ctx) => {
      ctx.use(Crumbs)({ label: "Products" });
      ctx.use(Meta)({ title: "Widget" });
      ctx.use(Crumbs)({ label: "Widget" });
      return { name: "Widget" };
    });
    const entry = entryWith([cachedEntry(loader, store)]);
    // The owning segment's bucket is shared with the entry's handler: a
    // handler push that lands first must survive the replay (append, not
    // restoreHandles' replace).
    const handlerPush = (reqCtx: any) =>
      reqCtx._handleStore.push(Crumbs.$$id, "R0", { label: "Home" });

    const miss = await runRequest(entry, { beforeLoaders: handlerPush });
    const hit = await runRequest(entry, { beforeLoaders: handlerPush });

    expect(loader.calls).toBe(1);
    const expected = {
      [Crumbs.$$id]: [
        { label: "Home" },
        { label: "Products" },
        { label: "Widget" },
      ],
      [Meta.$$id]: [{ title: "Widget" }],
    };
    expect(miss.handles).toEqual(expected);
    expect(hit.handles).toEqual(expected);
  });

  it("records only the loader body's own pushes, not concurrent pushes into the same store", async () => {
    const store = new MemorySegmentCacheStore();
    let release!: () => void;
    const loader = defineLoader("ProductLoader#L", async (ctx) => {
      ctx.use(Crumbs)({ label: "Widget" });
      await new Promise<void>((r) => {
        release = r;
      });
      return { name: "Widget" };
    });
    const entry = entryWith([cachedEntry(loader, store)]);

    // While the MISS body is suspended, the handler pushes into the same
    // segment. It re-runs on every request, so recording it would duplicate
    // it on the HIT.
    const miss = await runRequest(entry, {
      whileLoading: async (reqCtx) => {
        await vi.waitFor(() => expect(release).toBeTypeOf("function"));
        reqCtx._handleStore.push(Crumbs.$$id, "R0", { label: "Home" });
        release();
      },
    });
    expect(miss.handles[Crumbs.$$id]).toEqual([
      { label: "Widget" },
      { label: "Home" },
    ]);

    const hit = await runRequest(entry, {
      beforeLoaders: (reqCtx) =>
        reqCtx._handleStore.push(Crumbs.$$id, "R0", { label: "Home" }),
    });
    expect(loader.calls).toBe(1);
    expect(hit.handles[Crumbs.$$id]).toEqual([
      { label: "Home" },
      { label: "Widget" },
    ]);
  });

  it("records pushes from loaders the cached body awaits via ctx.use (they do not run on the HIT either)", async () => {
    const store = new MemorySegmentCacheStore();
    const category = defineLoader("CategoryLoader#L", async (ctx) => {
      ctx.use(Crumbs)({ label: "Products" });
      return { slug: "products" };
    });
    const loader = defineLoader("ProductLoader#L", async (ctx) => {
      const { slug } = await ctx.use(category);
      ctx.use(Crumbs)({ label: "Widget" });
      return { name: "Widget", slug };
    });
    const entry = entryWith([cachedEntry(loader, store)]);

    const miss = await runRequest(entry);
    const hit = await runRequest(entry);

    expect(loader.calls).toBe(1);
    expect(category.calls).toBe(1);
    const expected = [{ label: "Products" }, { label: "Widget" }];
    expect(miss.handles[Crumbs.$$id]).toEqual(expected);
    expect(hit.handles[Crumbs.$$id]).toEqual(expected);
  });

  it("serves an entry written without handles (pre-existing format): data, no replay, no error", async () => {
    const store = new MemorySegmentCacheStore();
    const loader = defineLoader("ProductLoader#L", async (ctx) => {
      ctx.use(Meta)({ title: "Widget" });
      return { name: "fresh" };
    });
    await store.setItem(
      "loader:ProductLoader#L:localhost/product",
      JSON.stringify({ name: "cached" }),
      { ttl: 60 },
    );

    const hit = await runRequest(entryWith([cachedEntry(loader, store)]));

    expect(loader.calls).toBe(0);
    expect(hit.data).toEqual([{ name: "cached" }]);
    expect(hit.handles).toEqual({});
  });

  it("a loader without its own cache installs no capture on the handle store", async () => {
    const loader = defineLoader("PlainLoader#L", async (ctx) => {
      ctx.use(Meta)({ title: "Plain" });
      return { ok: true };
    });
    const entry = entryWith([
      { loader, revalidate: [] } as unknown as LoaderEntry,
    ]);
    let pushBefore: unknown;

    const result = await runRequest(entry, {
      beforeLoaders: (reqCtx) => {
        pushBefore = reqCtx._handleStore.push;
      },
    });

    expect(result.handles[Meta.$$id]).toEqual([{ title: "Plain" }]);
    // startHandleCapture replaces push on first use; an untouched push means
    // the uncached path never entered the capture machinery.
    expect(result.reqCtx._handleStore.push).toBe(pushBefore);
  });

  it("captures only on the MISS: a HIT leaves the handle store's push untouched", async () => {
    const store = new MemorySegmentCacheStore();
    const loader = defineLoader("ProductLoader#L", async (ctx) => {
      ctx.use(Meta)({ title: "Widget" });
      return { name: "Widget" };
    });
    const entry = entryWith([cachedEntry(loader, store)]);
    let pushBefore: unknown;
    const recordPush = (reqCtx: any) => {
      pushBefore = reqCtx._handleStore.push;
    };

    const miss = await runRequest(entry, { beforeLoaders: recordPush });
    expect(miss.reqCtx._handleStore.push).not.toBe(pushBefore);

    const hit = await runRequest(entry, { beforeLoaders: recordPush });
    expect(hit.reqCtx._handleStore.push).toBe(pushBefore);
    expect(hit.handles[Meta.$$id]).toEqual([{ title: "Widget" }]);
  });

  it("stale hit: replays the entry's pushes, keeps the revalidation's pushes out of the live store, and refreshes the entry's handles", async () => {
    const store = new MemorySegmentCacheStore();
    // Serve the next read as stale (shouldRevalidate) without moving the
    // clock: the SWR branch is the read-through's, not the store's.
    let serveStale = false;
    const getItem = store.getItem.bind(store);
    store.getItem = async (key) => {
      const hit = await getItem(key);
      return hit && serveStale ? { ...hit, shouldRevalidate: true } : hit;
    };
    const loader = defineLoader("ProductLoader#L", async (ctx) => {
      const version = loader.calls;
      ctx.use(Meta)({ title: `v${version}` });
      return { version };
    });
    const entry = entryWith([cachedEntry(loader, store)]);

    const miss = await runRequest(entry);
    expect(miss.data).toEqual([{ version: 1 }]);
    expect(miss.handles[Meta.$$id]).toEqual([{ title: "v1" }]);

    // Stale v1 served; v2 revalidates in the background.
    serveStale = true;
    const stale = await runRequest(entry);
    serveStale = false;
    expect(loader.calls).toBe(2);
    expect(stale.data).toEqual([{ version: 1 }]);
    expect(stale.handles[Meta.$$id]).toEqual([{ title: "v1" }]);

    // The refreshed entry carries the revalidation's pushes.
    const hit = await runRequest(entry);
    expect(loader.calls).toBe(2);
    expect(hit.data).toEqual([{ version: 2 }]);
    expect(hit.handles[Meta.$$id]).toEqual([{ title: "v2" }]);
  });

  it("stale hit: the replay reaches the live store while the revalidation body is still pushing", async () => {
    const store = new MemorySegmentCacheStore();
    let serveStale = false;
    const getItem = store.getItem.bind(store);
    store.getItem = async (key) => {
      const hit = await getItem(key);
      return hit && serveStale ? { ...hit, shouldRevalidate: true } : hit;
    };
    let releaseRevalidation!: () => void;
    const revalidationGate = new Promise<void>((r) => {
      releaseRevalidation = r;
    });
    const loader = defineLoader("ProductLoader#L", async (ctx) => {
      const version = loader.calls;
      ctx.use(Meta)({ title: `v${version}` });
      // Hold the revalidation body (and its diverting capture) open across
      // the foreground replay.
      if (version === 2) await revalidationGate;
      return { version };
    });
    const entry = entryWith([cachedEntry(loader, store)]);

    await runRequest(entry);
    serveStale = true;
    const stale = await runRequest(entry, {
      afterLoaders: () => releaseRevalidation(),
    });
    serveStale = false;
    expect(stale.handles[Meta.$$id]).toEqual([{ title: "v1" }]);

    const hit = await runRequest(entry);
    expect(loader.calls).toBe(2);
    expect(hit.handles[Meta.$$id]).toEqual([{ title: "v2" }]);
  });

  it("holds the handle stream open for the replay while a slow store read is in flight", async () => {
    const store = new MemorySegmentCacheStore();
    let readGate: Promise<void> | undefined;
    const getItem = store.getItem.bind(store);
    store.getItem = async (key) => {
      await readGate;
      return getItem(key);
    };
    const loader = defineLoader("ProductLoader#L", async (ctx) => {
      ctx.use(Meta)({ title: "Widget" });
      return { name: "Widget" };
    });
    const entry = entryWith([cachedEntry(loader, store)]);
    await runRequest(entry);

    let releaseRead!: () => void;
    readGate = new Promise<void>((r) => {
      releaseRead = r;
    });
    let drained: Promise<void> | undefined;
    const hit = await runRequest(entry, {
      // The handle stream is consumed (sealed) and the handler lane is empty
      // while getItem is still pending: only the loader's own aux-lane
      // tracking keeps the store from completing before the replay pushes.
      whileLoading: async (reqCtx) => {
        drained = (async () => {
          for await (const _ of reqCtx._handleStore.stream()) {
            // drain
          }
        })();
        await new Promise((r) => setTimeout(r, 0));
        releaseRead();
      },
    });
    await drained;

    expect(hit.data).toEqual([{ name: "Widget" }]);
    expect(hit.handles[Meta.$$id]).toEqual([{ title: "Widget" }]);
  });
});
