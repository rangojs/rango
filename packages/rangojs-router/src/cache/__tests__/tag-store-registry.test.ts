import { describe, it, expect, beforeEach } from "vitest";
import { MemorySegmentCacheStore } from "../memory-segment-store.js";
import { resolveCacheStore } from "../cache-policy.js";
import type { SegmentCacheStore } from "../types.js";
import { runWithRequestContext } from "../../server/request-context.js";
import { makeRequestContext } from "../../__tests__/kit/request-context.js";

const EXAMPLE_URL = "https://example.com/";

/**
 * The explicit-store registry is how updateTag()/revalidateTag() reach stores
 * configured via cache({ store }) that are not the app-level store. Registration
 * happens at the single store-resolution chokepoint (resolveCacheStore), which
 * every cache axis (segment, response, loader) funnels through. The registry Set
 * is owned by the handler (created once per createRSCHandler) and threaded into
 * each request context, so it accumulates every explicit store the handler
 * resolves regardless of which request resolved it.
 */
describe("explicit tagged-store registry (resolveCacheStore)", () => {
  beforeEach(() => {
    MemorySegmentCacheStore.resetGlobalCache();
  });

  it("registers an explicit cache({ store }) store into the handler set", async () => {
    const appStore = new MemorySegmentCacheStore();
    const customStore = new MemorySegmentCacheStore();
    const explicitTaggedStores = new Set<SegmentCacheStore>();
    const ctx = makeRequestContext({
      url: EXAMPLE_URL,
      cacheStore: appStore,
      explicitTaggedStores,
    });

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
    const ctx = makeRequestContext({
      url: EXAMPLE_URL,
      cacheStore: appStore,
      explicitTaggedStores,
    });

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

    await runWithRequestContext(
      makeRequestContext({ url: EXAMPLE_URL, explicitTaggedStores }),
      async () => {
        resolveCacheStore(store1);
      },
    );
    await runWithRequestContext(
      makeRequestContext({ url: EXAMPLE_URL, explicitTaggedStores }),
      async () => {
        resolveCacheStore(store2);
      },
    );

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
      makeRequestContext({ url: EXAMPLE_URL, explicitTaggedStores: setA }),
      async () => {
        resolveCacheStore(storeA);
      },
    );
    await runWithRequestContext(
      makeRequestContext({ url: EXAMPLE_URL, explicitTaggedStores: setB }),
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
    await runWithRequestContext(
      makeRequestContext({ url: EXAMPLE_URL, explicitTaggedStores }),
      async () => {
        for (let i = 0; i < 50; i++) resolveCacheStore(store);
      },
    );
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
    await runWithRequestContext(
      makeRequestContext({ url: EXAMPLE_URL, explicitTaggedStores }),
      async () => {
        for (const s of stores) resolveCacheStore(s);
      },
    );
    // Growth is bounded (not 200), and the most-recent stores win over the oldest.
    expect(explicitTaggedStores.size).toBeLessThanOrEqual(64);
    expect(explicitTaggedStores.has(stores[199])).toBe(true);
    expect(explicitTaggedStores.has(stores[0])).toBe(false);
  });

  it("moves a re-resolved store to the most-recent end, so eviction takes the least recently resolved (LRU touch)", async () => {
    const explicitTaggedStores = new Set<SegmentCacheStore>();
    // EXPLICIT_STORE_REGISTRY_CAP in cache-policy.ts.
    const stores = Array.from(
      { length: 64 },
      () => new MemorySegmentCacheStore(),
    );
    const newcomer = new MemorySegmentCacheStore();
    // Stores are compared by identity: distinct empty stores are deep-equal.
    const names = new Map<SegmentCacheStore, string>(
      stores.map((s, i) => [s, `s${i}`]),
    );
    names.set(newcomer, "newcomer");
    await runWithRequestContext(
      makeRequestContext({ url: EXAMPLE_URL, explicitTaggedStores }),
      async () => {
        for (const s of stores) resolveCacheStore(s);
        // A module-singleton store is re-resolved on a later request.
        resolveCacheStore(stores[0]);
        resolveCacheStore(newcomer);
      },
    );
    // s0 moved behind s63, so the newcomer evicted s1, not s0.
    expect([...explicitTaggedStores].map((s) => names.get(s))).toEqual([
      ...stores.slice(2).map((s) => names.get(s)),
      "s0",
      "newcomer",
    ]);
  });
});
