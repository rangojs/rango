import { describe, it, expect, beforeEach } from "vitest";
import { MemorySegmentCacheStore } from "../memory-segment-store.js";
import { resolveCacheStore } from "../cache-policy.js";
import type { SegmentCacheStore } from "../types.js";
import {
  createRequestContext,
  runWithRequestContext,
} from "../../server/request-context.js";

/**
 * The explicit-store registry is how updateTag()/revalidateTag() reach stores
 * configured via cache({ store }) that are not the app-level store. Registration
 * happens at the single store-resolution chokepoint (resolveCacheStore), which
 * every cache axis (segment, response, loader) funnels through. The registry Set
 * is owned by the handler (created once per createRSCHandler) and threaded into
 * each request context, so it accumulates every explicit store the handler
 * resolves regardless of which request resolved it.
 */
function makeCtx(opts: {
  cacheStore?: SegmentCacheStore;
  explicitTaggedStores?: Set<SegmentCacheStore>;
}) {
  return createRequestContext({
    env: {},
    request: new Request("https://example.com/"),
    url: new URL("https://example.com/"),
    variables: {},
    cacheStore: opts.cacheStore,
    explicitTaggedStores: opts.explicitTaggedStores,
  });
}

describe("explicit tagged-store registry (resolveCacheStore)", () => {
  beforeEach(() => {
    MemorySegmentCacheStore.resetGlobalCache();
  });

  it("registers an explicit cache({ store }) store into the handler set", async () => {
    const appStore = new MemorySegmentCacheStore();
    const customStore = new MemorySegmentCacheStore();
    const explicitTaggedStores = new Set<SegmentCacheStore>();
    const ctx = makeCtx({ cacheStore: appStore, explicitTaggedStores });

    await runWithRequestContext(ctx, async () => {
      const resolved = resolveCacheStore(customStore);
      expect(resolved).toBe(customStore);
    });

    expect(explicitTaggedStores.has(customStore)).toBe(true);
    // The app-level store is reachable via ctx._cacheStore and must not be
    // duplicated into the explicit registry.
    expect(explicitTaggedStores.has(appStore)).toBe(false);
  });

  it("does not register the app-level store (resolved via _cacheStore)", async () => {
    const appStore = new MemorySegmentCacheStore();
    const explicitTaggedStores = new Set<SegmentCacheStore>();
    const ctx = makeCtx({ cacheStore: appStore, explicitTaggedStores });

    await runWithRequestContext(ctx, async () => {
      const resolved = resolveCacheStore(undefined);
      expect(resolved).toBe(appStore);
    });

    expect(explicitTaggedStores.size).toBe(0);
  });

  it("accumulates explicit stores across requests sharing the handler set", async () => {
    // One handler-owned Set, reused across two separate request contexts.
    const explicitTaggedStores = new Set<SegmentCacheStore>();
    const store1 = new MemorySegmentCacheStore();
    const store2 = new MemorySegmentCacheStore();

    await runWithRequestContext(makeCtx({ explicitTaggedStores }), async () => {
      resolveCacheStore(store1);
    });
    await runWithRequestContext(makeCtx({ explicitTaggedStores }), async () => {
      resolveCacheStore(store2);
    });

    expect(explicitTaggedStores.has(store1)).toBe(true);
    expect(explicitTaggedStores.has(store2)).toBe(true);
    expect(explicitTaggedStores.size).toBe(2);
  });

  it("isolates registries between handlers (multi-router)", async () => {
    const setA = new Set<SegmentCacheStore>();
    const setB = new Set<SegmentCacheStore>();
    const storeA = new MemorySegmentCacheStore();
    const storeB = new MemorySegmentCacheStore();

    await runWithRequestContext(
      makeCtx({ explicitTaggedStores: setA }),
      async () => {
        resolveCacheStore(storeA);
      },
    );
    await runWithRequestContext(
      makeCtx({ explicitTaggedStores: setB }),
      async () => {
        resolveCacheStore(storeB);
      },
    );

    expect(setA.has(storeA)).toBe(true);
    expect(setA.has(storeB)).toBe(false);
    expect(setB.has(storeB)).toBe(true);
    expect(setB.has(storeA)).toBe(false);
  });

  it("dedupes when the same explicit store is resolved many times", async () => {
    const explicitTaggedStores = new Set<SegmentCacheStore>();
    const store = new MemorySegmentCacheStore();
    await runWithRequestContext(makeCtx({ explicitTaggedStores }), async () => {
      for (let i = 0; i < 50; i++) resolveCacheStore(store);
    });
    expect(explicitTaggedStores.size).toBe(1);
  });

  // Leak guard (#6): the registry persists across requests on purpose (so a
  // server action's updateTag can reach stores a prior render registered), but a
  // store constructed PER request/boundary (e.g. a ctx-bound CFCacheStore) would
  // otherwise accumulate one dead instance per request unbounded. The registry is
  // LRU-bounded.
  it("bounds registry growth and evicts least-recently-resolved stores", async () => {
    const explicitTaggedStores = new Set<SegmentCacheStore>();
    const stores = Array.from(
      { length: 200 },
      () => new MemorySegmentCacheStore(),
    );
    await runWithRequestContext(makeCtx({ explicitTaggedStores }), async () => {
      for (const s of stores) resolveCacheStore(s);
    });
    // Growth is bounded (not 200), and the most-recent stores win over the oldest.
    expect(explicitTaggedStores.size).toBeLessThanOrEqual(64);
    expect(explicitTaggedStores.has(stores[199])).toBe(true);
    expect(explicitTaggedStores.has(stores[0])).toBe(false);
  });

  it("keeps a re-resolved (live) store reachable despite per-request churn (LRU touch)", async () => {
    const explicitTaggedStores = new Set<SegmentCacheStore>();
    const liveStore = new MemorySegmentCacheStore();
    const churn = Array.from(
      { length: 200 },
      () => new MemorySegmentCacheStore(),
    );
    await runWithRequestContext(makeCtx({ explicitTaggedStores }), async () => {
      for (const s of churn) {
        // A module-singleton store is re-resolved on every request.
        resolveCacheStore(liveStore);
        resolveCacheStore(s);
      }
    });
    expect(explicitTaggedStores.has(liveStore)).toBe(true);
  });
});
