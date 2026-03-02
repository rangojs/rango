import { describe, it, expect, beforeEach } from "vitest";
import { MemorySegmentCacheStore } from "../memory-segment-store.js";
import {
  registerTaggedStore,
  getTaggedStores,
  resetTagStoreRegistry,
} from "../tag-store-registry.js";

describe("tag-store-registry", () => {
  beforeEach(() => {
    resetTagStoreRegistry();
    MemorySegmentCacheStore.resetGlobalCache();
  });

  it("starts empty", () => {
    expect(getTaggedStores().size).toBe(0);
  });

  it("registers a store", () => {
    const store = new MemorySegmentCacheStore();
    registerTaggedStore(store);
    expect(getTaggedStores().has(store)).toBe(true);
  });

  it("deduplicates the same store instance", () => {
    const store = new MemorySegmentCacheStore();
    registerTaggedStore(store);
    registerTaggedStore(store);
    expect(getTaggedStores().size).toBe(1);
  });

  it("tracks multiple stores", () => {
    const store1 = new MemorySegmentCacheStore();
    const store2 = new MemorySegmentCacheStore();
    registerTaggedStore(store1);
    registerTaggedStore(store2);
    expect(getTaggedStores().size).toBe(2);
  });

  describe("cross-store revalidation", () => {
    it("revalidateTag on explicit store invalidates its tagged entries", async () => {
      const appStore = new MemorySegmentCacheStore();
      const customStore = new MemorySegmentCacheStore();

      // Write tagged entry to customStore (simulates cache({ store: customStore, tags }))
      await customStore.setItem("key1", "custom-value", {
        ttl: 60,
        tags: ["catalog"],
      });
      registerTaggedStore(customStore);

      // Write unrelated entry to appStore
      await appStore.setItem("key2", "app-value", {
        ttl: 60,
        tags: ["other"],
      });
      registerTaggedStore(appStore);

      // Simulate what revalidateTag() does: iterate all tagged stores
      for (const store of getTaggedStores()) {
        if (store.revalidateTag) {
          await store.revalidateTag("catalog");
        }
      }

      // customStore entry should be invalidated
      expect(await customStore.getItem("key1")).toBeNull();
      // appStore entry should be untouched
      expect(await appStore.getItem("key2")).not.toBeNull();
    });

    it("invalidates across multiple stores for the same tag", async () => {
      const store1 = new MemorySegmentCacheStore();
      const store2 = new MemorySegmentCacheStore();

      await store1.setItem("k1", "v1", { ttl: 60, tags: ["shared"] });
      await store2.setItem("k2", "v2", { ttl: 60, tags: ["shared"] });
      registerTaggedStore(store1);
      registerTaggedStore(store2);

      for (const store of getTaggedStores()) {
        if (store.revalidateTag) {
          await store.revalidateTag("shared");
        }
      }

      expect(await store1.getItem("k1")).toBeNull();
      expect(await store2.getItem("k2")).toBeNull();
    });
  });
});
