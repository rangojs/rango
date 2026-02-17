import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { MemorySegmentCacheStore } from "../memory-segment-store";
import type { CachedEntryData } from "../types";

describe("MemorySegmentCacheStore", () => {
  beforeEach(() => {
    // Clear the global cache between tests
    MemorySegmentCacheStore.resetGlobalCache();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const createTestData = (id: string = "test-segment"): CachedEntryData => ({
    segments: [
      {
        encoded: "test-component-" + id,
        metadata: {
          id,
          type: "route",
          namespace: "test",
          index: 0,
          params: {},
        },
      },
    ],
    handles: {},
    expiresAt: Date.now() + 60000,
  });

  describe("constructor", () => {
    it("should create store without options", () => {
      const store = new MemorySegmentCacheStore();
      expect(store).toBeDefined();
      expect(store.defaults).toBeUndefined();
    });

    it("should accept default options", () => {
      const store = new MemorySegmentCacheStore({
        defaults: { ttl: 120, swr: 300 },
      });
      expect(store.defaults).toEqual({ ttl: 120, swr: 300 });
    });

    it("should use globalThis for HMR survival with named stores", () => {
      const store1 = new MemorySegmentCacheStore({ name: "hmr-test" });
      store1.set("key", createTestData(), 60);

      // Create new instance with same name - should share the same cache
      const store2 = new MemorySegmentCacheStore({ name: "hmr-test" });
      const stats = store2.getStats();

      expect(stats.size).toBe(1);
      expect(stats.keys).toContain("key");
    });

    it("should isolate unnamed store instances", () => {
      const store1 = new MemorySegmentCacheStore();
      store1.set("key", createTestData(), 60);

      // Create new unnamed instance - should NOT share the same cache
      const store2 = new MemorySegmentCacheStore();
      const stats = store2.getStats();

      expect(stats.size).toBe(0);
    });

    it("should isolate named stores with different names", () => {
      const store1 = new MemorySegmentCacheStore({ name: "store-a" });
      store1.set("key", createTestData(), 60);

      const store2 = new MemorySegmentCacheStore({ name: "store-b" });
      expect(store2.getStats().size).toBe(0);

      // Each store only sees its own data
      store2.set("other-key", createTestData(), 60);
      expect(store1.getStats().size).toBe(1);
      expect(store1.getStats().keys).toContain("key");
      expect(store2.getStats().size).toBe(1);
      expect(store2.getStats().keys).toContain("other-key");
    });
  });

  describe("resetGlobalCache", () => {
    it("should clear global cache registry for named stores", async () => {
      const store1 = new MemorySegmentCacheStore({ name: "reset-test" });
      await store1.set("key", createTestData(), 60);
      expect(store1.getStats().size).toBe(1);

      // Reset global cache registry
      MemorySegmentCacheStore.resetGlobalCache();

      // New named store should have empty cache
      const store2 = new MemorySegmentCacheStore({ name: "reset-test" });
      expect(store2.getStats().size).toBe(0);
    });

    it("should not affect existing store instance cache reference", async () => {
      const store = new MemorySegmentCacheStore({ name: "stale-ref-test" });
      await store.set("key", createTestData(), 60);

      // Reset destroys the registry, but existing store still holds its Map reference
      MemorySegmentCacheStore.resetGlobalCache();

      // Old store still sees its data (stale reference)
      expect(store.getStats().size).toBe(1);

      // But new named store has fresh empty cache
      const newStore = new MemorySegmentCacheStore({ name: "stale-ref-test" });
      expect(newStore.getStats().size).toBe(0);
    });
  });

  describe("get/set", () => {
    it("should return null for missing key", async () => {
      const store = new MemorySegmentCacheStore();
      const result = await store.get("missing-key");
      expect(result).toBeNull();
    });

    it("should store and retrieve data", async () => {
      const store = new MemorySegmentCacheStore();
      const data = createTestData();

      await store.set("test-key", data, 60);
      const result = await store.get("test-key");

      expect(result).not.toBeNull();
      expect(result!.data.segments).toEqual(data.segments);
      expect(result!.data.handles).toEqual(data.handles);
    });

    it("should always return shouldRevalidate=false (no SWR support)", async () => {
      const store = new MemorySegmentCacheStore();
      const data = createTestData();

      await store.set("test-key", data, 60, 300); // SWR param is ignored
      const result = await store.get("test-key");

      expect(result!.shouldRevalidate).toBe(false);
    });

    it("should handle multiple entries", async () => {
      const store = new MemorySegmentCacheStore();

      await store.set("key1", createTestData("seg1"), 60);
      await store.set("key2", createTestData("seg2"), 60);
      await store.set("key3", createTestData("seg3"), 60);

      const result1 = await store.get("key1");
      const result2 = await store.get("key2");
      const result3 = await store.get("key3");

      expect(result1!.data.segments[0].metadata.id).toBe("seg1");
      expect(result2!.data.segments[0].metadata.id).toBe("seg2");
      expect(result3!.data.segments[0].metadata.id).toBe("seg3");
    });
  });

  describe("TTL expiration", () => {
    it("should calculate expiresAt from TTL", async () => {
      vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));

      const store = new MemorySegmentCacheStore();
      const data = createTestData();

      await store.set("key", data, 60);

      // Should be available before TTL
      vi.advanceTimersByTime(59 * 1000);
      let result = await store.get("key");
      expect(result).not.toBeNull();

      // Should expire after TTL
      vi.advanceTimersByTime(2 * 1000);
      result = await store.get("key");
      expect(result).toBeNull();
    });

    it("should delete expired entries on get", async () => {
      vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));

      const store = new MemorySegmentCacheStore();
      await store.set("key", createTestData(), 5);

      const stats1 = store.getStats();
      expect(stats1.size).toBe(1);

      vi.advanceTimersByTime(6 * 1000);
      await store.get("key");

      const stats2 = store.getStats();
      expect(stats2.size).toBe(0);
    });

    it("should handle different TTLs for different entries", async () => {
      vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));

      const store = new MemorySegmentCacheStore();
      await store.set("short", createTestData("short"), 10);
      await store.set("long", createTestData("long"), 100);

      vi.advanceTimersByTime(50 * 1000);

      const shortResult = await store.get("short");
      const longResult = await store.get("long");

      expect(shortResult).toBeNull();
      expect(longResult).not.toBeNull();
    });
  });

  describe("delete", () => {
    it("should delete existing entry", async () => {
      const store = new MemorySegmentCacheStore();
      await store.set("key", createTestData(), 60);

      const deleted = await store.delete("key");
      expect(deleted).toBe(true);

      const result = await store.get("key");
      expect(result).toBeNull();
    });

    it("should return false for non-existent key", async () => {
      const store = new MemorySegmentCacheStore();
      const deleted = await store.delete("missing");
      expect(deleted).toBe(false);
    });
  });

  describe("clear", () => {
    it("should clear all entries", async () => {
      const store = new MemorySegmentCacheStore();
      await store.set("key1", createTestData("seg1"), 60);
      await store.set("key2", createTestData("seg2"), 60);

      await store.clear();

      const stats = store.getStats();
      expect(stats.size).toBe(0);
      expect(stats.keys).toEqual([]);
    });
  });

  describe("getStats", () => {
    it("should return empty stats for new store", () => {
      const store = new MemorySegmentCacheStore();
      const stats = store.getStats();

      expect(stats.size).toBe(0);
      expect(stats.keys).toEqual([]);
    });

    it("should return correct stats after operations", async () => {
      const store = new MemorySegmentCacheStore();
      await store.set("key1", createTestData(), 60);
      await store.set("key2", createTestData(), 60);

      const stats = store.getStats();

      expect(stats.size).toBe(2);
      expect(stats.keys).toContain("key1");
      expect(stats.keys).toContain("key2");
    });
  });

  describe("edge cases", () => {
    it("should handle special characters in keys", async () => {
      const store = new MemorySegmentCacheStore();
      const key = "route:/products/cat=electronics&page=1";
      const data = createTestData();

      await store.set(key, data, 60);
      const result = await store.get(key);

      expect(result).not.toBeNull();
      expect(result!.data).toBeDefined();
    });

    it("should overwrite existing entries with same key", async () => {
      const store = new MemorySegmentCacheStore();

      await store.set("key", createTestData("first"), 60);
      await store.set("key", createTestData("second"), 60);

      const result = await store.get("key");
      expect(result!.data.segments[0].metadata.id).toBe("second");

      const stats = store.getStats();
      expect(stats.size).toBe(1);
    });

    it("should handle empty handles object", async () => {
      const store = new MemorySegmentCacheStore();
      const data: CachedEntryData = {
        segments: [],
        handles: {},
        expiresAt: Date.now() + 60000,
      };

      await store.set("key", data, 60);
      const result = await store.get("key");

      expect(result!.data.handles).toEqual({});
    });

    it("should handle complex segment data", async () => {
      const store = new MemorySegmentCacheStore();
      const data: CachedEntryData = {
        segments: [
          {
            encoded: "layout-component",
            metadata: {
              id: "layout",
              type: "layout",
              namespace: "root",
              index: 0,
              params: {},
            },
          },
          {
            encoded: "page-component",
            metadata: {
              id: "page",
              type: "route",
              namespace: "products",
              index: 1,
              params: { id: "123" },
            },
          },
        ],
        handles: {
          layout: { title: ["My App"] },
          page: { meta: [{ description: "Product page" }] },
        },
        expiresAt: Date.now() + 60000,
      };

      await store.set("key", data, 60);
      const result = await store.get("key");

      expect(result!.data.segments).toHaveLength(2);
      expect(result!.data.handles).toEqual(data.handles);
    });

    it("should handle TTL of 0 (immediate expiration)", async () => {
      vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));

      const store = new MemorySegmentCacheStore();
      await store.set("key", createTestData(), 0);

      vi.advanceTimersByTime(1);
      const result = await store.get("key");
      expect(result).toBeNull();
    });

    it("should handle very large TTL", async () => {
      vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));

      const store = new MemorySegmentCacheStore();
      await store.set("key", createTestData(), 365 * 24 * 60 * 60); // 1 year

      // Advance 6 months
      vi.advanceTimersByTime(180 * 24 * 60 * 60 * 1000);
      const result = await store.get("key");
      expect(result).not.toBeNull();
    });

    it("should handle many segments in one entry", async () => {
      const store = new MemorySegmentCacheStore();
      const data: CachedEntryData = {
        segments: Array.from({ length: 50 }, (_, i) => ({
          encoded: `component-${i}`,
          metadata: {
            id: `segment-${i}`,
            type: "route" as const,
            namespace: `ns-${i}`,
            index: i,
            params: { index: String(i) },
          },
        })),
        handles: {},
        expiresAt: Date.now() + 60000,
      };

      await store.set("key", data, 60);
      const result = await store.get("key");

      expect(result!.data.segments).toHaveLength(50);
      expect(result!.data.segments[49].metadata.id).toBe("segment-49");
    });

    it("should handle unicode in segment data", async () => {
      const store = new MemorySegmentCacheStore();
      const data: CachedEntryData = {
        segments: [
          {
            encoded: "コンポーネント",
            metadata: {
              id: "日本語-segment",
              type: "route",
              namespace: "路由",
              index: 0,
              params: { name: "世界" },
            },
          },
        ],
        handles: {
          "日本語-segment": { title: ["こんにちは"] },
        },
        expiresAt: Date.now() + 60000,
      };

      await store.set("key", data, 60);
      const result = await store.get("key");

      expect(result!.data.segments[0].metadata.id).toBe("日本語-segment");
      expect(result!.data.handles["日本語-segment"]).toEqual({
        title: ["こんにちは"],
      });
    });

    it("should handle segments with all metadata fields", async () => {
      const store = new MemorySegmentCacheStore();
      const data: CachedEntryData = {
        segments: [
          {
            encoded: "full-component",
            encodedLayout: "layout-data",
            encodedLoading: "loading-data",
            encodedLoaderData: "loader-data",
            encodedLoaderDataPromise: "promise-data",
            metadata: {
              id: "full-segment",
              type: "route",
              namespace: "test",
              index: 0,
              params: { id: "123" },
              slot: "@modal",
              belongsToRoute: true,
              layoutName: "MainLayout",
              parallelName: "sidebar",
              loaderId: "loader-1",
              loaderIds: ["loader-1", "loader-2"],
            },
          },
        ],
        handles: {},
        expiresAt: Date.now() + 60000,
      };

      await store.set("key", data, 60);
      const result = await store.get("key");

      const seg = result!.data.segments[0];
      expect(seg.metadata.slot).toBe("@modal");
      expect(seg.metadata.belongsToRoute).toBe(true);
      expect(seg.metadata.layoutName).toBe("MainLayout");
      expect(seg.metadata.loaderIds).toEqual(["loader-1", "loader-2"]);
      expect(seg.encodedLayout).toBe("layout-data");
      expect(seg.encodedLoading).toBe("loading-data");
    });

    it("should handle concurrent access from named stores with same name", async () => {
      const store1 = new MemorySegmentCacheStore({ name: "shared" });
      const store2 = new MemorySegmentCacheStore({ name: "shared" });

      await store1.set("key1", createTestData("seg1"), 60);
      await store2.set("key2", createTestData("seg2"), 60);

      // Both named stores share the same underlying Map via globalThis
      const result1 = await store1.get("key2");
      const result2 = await store2.get("key1");

      expect(result1).not.toBeNull();
      expect(result2).not.toBeNull();
    });

    it("should isolate concurrent access from unnamed stores", async () => {
      const store1 = new MemorySegmentCacheStore();
      const store2 = new MemorySegmentCacheStore();

      await store1.set("key1", createTestData("seg1"), 60);
      await store2.set("key2", createTestData("seg2"), 60);

      // Unnamed stores are isolated; each only sees its own data
      const result1 = await store1.get("key2");
      const result2 = await store2.get("key1");

      expect(result1).toBeNull();
      expect(result2).toBeNull();
    });

    it("should handle rapid successive operations", async () => {
      const store = new MemorySegmentCacheStore();

      // Rapid set/get/delete operations
      for (let i = 0; i < 100; i++) {
        await store.set(`key${i}`, createTestData(`seg${i}`), 60);
      }

      expect(store.getStats().size).toBe(100);

      for (let i = 0; i < 50; i++) {
        await store.delete(`key${i}`);
      }

      expect(store.getStats().size).toBe(50);
    });

    it("should handle entries with empty segments array", async () => {
      const store = new MemorySegmentCacheStore();
      const data: CachedEntryData = {
        segments: [],
        handles: {},
        expiresAt: Date.now() + 60000,
      };

      await store.set("key", data, 60);
      const result = await store.get("key");

      expect(result!.data.segments).toEqual([]);
    });
  });
});
