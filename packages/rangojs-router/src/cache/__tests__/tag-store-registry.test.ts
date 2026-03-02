import { describe, it, expect, beforeEach } from "vitest";
import { MemorySegmentCacheStore } from "../memory-segment-store.js";
import type { SegmentCacheStore } from "../types.js";

/**
 * Tests for handler-scoped explicit store tracking.
 *
 * In production, _explicitTaggedStores is a Set created once per
 * createRSCHandler() and shared across all request contexts for that
 * handler. revalidateTag() iterates ctx._cacheStore (app-level) +
 * ctx._explicitTaggedStores (per-scope) to cover all stores.
 *
 * These tests simulate the lifecycle without a full handler/request context.
 */

/** Simulate what revalidateTag() does: iterate app store + explicit stores */
async function revalidateTagAcrossStores(
  tag: string,
  appStore: SegmentCacheStore | undefined,
  explicitStores: Set<SegmentCacheStore> | undefined,
): Promise<void> {
  const stores = new Set<{ revalidateTag(tag: string): Promise<void> }>();
  if (appStore?.revalidateTag) {
    stores.add(appStore as { revalidateTag(tag: string): Promise<void> });
  }
  if (explicitStores) {
    for (const store of explicitStores) {
      if (store.revalidateTag) {
        stores.add(store as { revalidateTag(tag: string): Promise<void> });
      }
    }
  }
  await Promise.all([...stores].map((s) => s.revalidateTag(tag)));
}

describe("handler-scoped explicit store tracking", () => {
  beforeEach(() => {
    MemorySegmentCacheStore.resetGlobalCache();
  });

  describe("cross-store revalidation within one handler", () => {
    it("invalidates tagged entries in explicit store via revalidateTag", async () => {
      const appStore = new MemorySegmentCacheStore();
      const customStore = new MemorySegmentCacheStore();

      // Handler-scoped set (created once per createRSCHandler)
      const explicitStores = new Set<SegmentCacheStore>();

      // Write tagged entry to customStore (simulates cache({ store: customStore, tags }))
      await customStore.setItem("key1", "custom-value", {
        ttl: 60,
        tags: ["catalog"],
      });
      explicitStores.add(customStore);

      // Write unrelated entry to appStore
      await appStore.setItem("key2", "app-value", {
        ttl: 60,
        tags: ["other"],
      });

      await revalidateTagAcrossStores("catalog", appStore, explicitStores);

      expect(await customStore.getItem("key1")).toBeNull();
      expect(await appStore.getItem("key2")).not.toBeNull();
    });

    it("invalidates across multiple explicit stores for the same tag", async () => {
      const store1 = new MemorySegmentCacheStore();
      const store2 = new MemorySegmentCacheStore();

      const explicitStores = new Set<SegmentCacheStore>();

      await store1.setItem("k1", "v1", { ttl: 60, tags: ["shared"] });
      await store2.setItem("k2", "v2", { ttl: 60, tags: ["shared"] });
      explicitStores.add(store1);
      explicitStores.add(store2);

      await revalidateTagAcrossStores("shared", undefined, explicitStores);

      expect(await store1.getItem("k1")).toBeNull();
      expect(await store2.getItem("k2")).toBeNull();
    });

    it("deduplicates when explicit store is the same as app store", async () => {
      const sharedStore = new MemorySegmentCacheStore();

      const explicitStores = new Set<SegmentCacheStore>();
      explicitStores.add(sharedStore);

      await sharedStore.setItem("key1", "value", {
        ttl: 60,
        tags: ["tag-a"],
      });

      // The Set deduplicates, so revalidateTag is only called once
      await revalidateTagAcrossStores("tag-a", sharedStore, explicitStores);

      expect(await sharedStore.getItem("key1")).toBeNull();
    });
  });

  describe("multi-router isolation", () => {
    it("revalidateTag on router A does not touch router B explicit stores", async () => {
      // Router A
      const appStoreA = new MemorySegmentCacheStore();
      const explicitStoresA = new Set<SegmentCacheStore>();
      const customStoreA = new MemorySegmentCacheStore();
      explicitStoresA.add(customStoreA);

      // Router B (separate handler, separate set)
      const appStoreB = new MemorySegmentCacheStore();
      const explicitStoresB = new Set<SegmentCacheStore>();
      const customStoreB = new MemorySegmentCacheStore();
      explicitStoresB.add(customStoreB);

      // Both routers store entries with the same tag name
      await customStoreA.setItem("k", "from-A", { ttl: 60, tags: ["catalog"] });
      await customStoreB.setItem("k", "from-B", { ttl: 60, tags: ["catalog"] });

      // Router A invalidates "catalog" — only its stores are affected
      await revalidateTagAcrossStores("catalog", appStoreA, explicitStoresA);

      expect(await customStoreA.getItem("k")).toBeNull();
      expect(await customStoreB.getItem("k")).not.toBeNull();
      expect((await customStoreB.getItem("k"))!.value).toBe("from-B");
    });

    it("per-request app-level stores are never accumulated in handler set", () => {
      // Handler-scoped set (created once per createRSCHandler)
      const explicitStores = new Set<SegmentCacheStore>();
      const singletonExplicit = new MemorySegmentCacheStore();

      // Simulate 100 requests: each creates a per-request app store,
      // but only the singleton explicit store is added to the set
      for (let i = 0; i < 100; i++) {
        const perRequestAppStore = new MemorySegmentCacheStore();
        // Per-request app stores are NOT added — only explicit stores
        void perRequestAppStore;

        // Explicit stores from cache({ store }) are singletons
        explicitStores.add(singletonExplicit);
      }

      expect(explicitStores.size).toBe(1);
    });
  });
});
