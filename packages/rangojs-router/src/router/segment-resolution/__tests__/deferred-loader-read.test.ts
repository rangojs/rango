/**
 * A loader a prefetch deferred and something reads anyway: the read starts it
 * through its registration (prefetch-deferral.ts startDeferredLoader), so it
 * runs through resolveLoaderData with its own cache() binding, as resolution
 * would have started it. Driven through the real setupLoaderAccess executor
 * and executeLoaderData. The end-to-end version is
 * src/testing/__tests__/prefetch-false.rsc-test.tsx ("with its own cache()").
 */
import { describe, it, expect, vi } from "vitest";

// segment-codec pulls @vitejs/plugin-rsc (unresolvable in plain vitest).
vi.mock("../../../cache/segment-codec.js", () => ({
  serializeResult: vi.fn(async (value: unknown) => JSON.stringify(value)),
  deserializeResult: vi.fn(async (encoded: string) => JSON.parse(encoded)),
}));

import { resolveLoaderData } from "../loader-cache.js";
import {
  planPrefetchDeferral,
  registerDeferredLoader,
} from "../prefetch-deferral.js";
import { setupLoaderAccess } from "../../loader-resolution.js";
import { createHandlerContext } from "../../handler-context.js";
import {
  createRequestContext,
  runWithRequestContext,
} from "../../../server/request-context.js";
import {
  runInsideLoaderScope,
  type EntryData,
  type LoaderEntry,
} from "../../../server/context.js";
import { MemorySegmentCacheStore } from "../../../cache/memory-segment-store.js";
import type {
  InternalHandlerContext,
  LoaderContext,
  LoaderDefinition,
} from "../../../types.js";

function defineLoader(
  id: string,
): LoaderDefinition<any, any> & { calls: number } {
  const def = {
    __brand: "loader" as const,
    $$id: id,
    calls: 0,
    fn: async (_ctx: LoaderContext<any, any>) => ({ run: ++def.calls }),
  };
  return def;
}

/**
 * One prefetch request in which resolution registered `loader` as deferred
 * on segment "L0", then `read` runs with the handler context.
 */
async function prefetchReading<T>(
  loader: LoaderDefinition<any, any>,
  store: MemorySegmentCacheStore,
  read: (ctx: InternalHandlerContext<any, any>) => Promise<T>,
) {
  const loaderEntry = {
    loader,
    revalidate: [],
    prefetch: false,
    cache: { options: { store, ttl: 60 } },
  } as unknown as LoaderEntry;
  const route = {
    id: "route",
    shortCode: "R0",
    type: "route",
    loader: [loaderEntry],
    layout: [],
    parallel: {},
  } as unknown as EntryData;
  const request = new Request("http://localhost/product");
  const url = new URL(request.url);
  const reqCtx = createRequestContext({ env: {}, request, url, variables: {} });
  return runWithRequestContext(reqCtx, async () => {
    const ctx = createHandlerContext(
      {},
      request,
      url.searchParams,
      url.pathname,
      url,
      {},
    ) as InternalHandlerContext<any, any>;
    setupLoaderAccess(ctx, new Map());
    ctx._prefetchDeferral = planPrefetchDeferral([route], "prefetch", {}, null);
    registerDeferredLoader(ctx, loader.$$id, "L0", () =>
      runInsideLoaderScope(
        () => resolveLoaderData(loaderEntry, ctx, ctx.pathname),
        loader.$$id,
      ),
    );
    ctx._currentSegmentId = "R0";
    const value = await read(ctx);
    await Promise.all(reqCtx._pendingBackgroundTasks ?? []);
    return { value, ctx };
  });
}

/** One request whose read runs `loader` through its binding: warms `store`. */
async function warm(
  loader: LoaderDefinition<any, any>,
  store: MemorySegmentCacheStore,
) {
  await prefetchReading(loader, store, (ctx) => ctx.use(loader));
}

describe("a deferred loader something reads", () => {
  it("a handler read is served by the loader's cache() HIT: the body does not run", async () => {
    const store = new MemorySegmentCacheStore();
    const loader = defineLoader("Deferred#cached");
    await warm(loader, store);
    expect(loader.calls).toBe(1);

    const { value, ctx } = await prefetchReading(loader, store, async (c) => [
      await c.use(loader),
      await c.use(loader),
    ]);
    expect(value).toEqual([{ run: 1 }, { run: 1 }]);
    expect(loader.calls).toBe(1);
    expect(ctx._prefetchDeferral!.deferredLoaders!.get(loader.$$id)).toEqual(
      expect.objectContaining({ started: true }),
    );
    expect(ctx._loaderStarted!(loader.$$id)).toBe(true);
  });

  it("a cold read runs the body once through the binding's MISS and writes the entry", async () => {
    const store = new MemorySegmentCacheStore();
    const loader = defineLoader("Deferred#cold");
    const { value } = await prefetchReading(loader, store, (c) =>
      c.use(loader),
    );
    expect(value).toEqual({ run: 1 });
    expect(loader.calls).toBe(1);

    const again = await prefetchReading(loader, store, (c) => c.use(loader));
    expect(again.value).toEqual({ run: 1 });
    expect(loader.calls).toBe(1);
  });

  it("a stale refresh's isolated read does not start the registration", async () => {
    const store = new MemorySegmentCacheStore();
    const loader = defineLoader("Deferred#isolated");
    await warm(loader, store);

    const { value, ctx } = await prefetchReading(loader, store, (c) =>
      c._runLoaderIsolated!(loader),
    );
    expect(value).toEqual({ run: 2 });
    expect(
      ctx._prefetchDeferral!.deferredLoaders!.get(loader.$$id)!.started,
    ).toBeUndefined();
  });

  it("nothing reads it: it is not started and its cache() is not read", async () => {
    const store = new MemorySegmentCacheStore();
    const getItem = vi.spyOn(store, "getItem");
    const loader = defineLoader("Deferred#unread");
    const { ctx } = await prefetchReading(loader, store, async () => null);
    expect(loader.calls).toBe(0);
    expect(getItem).not.toHaveBeenCalled();
    expect(ctx._loaderStarted!(loader.$$id)).toBe(false);
  });
});
