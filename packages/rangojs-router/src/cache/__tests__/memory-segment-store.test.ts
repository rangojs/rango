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
    handles: "",
    expiresAt: Date.now() + 60000,
  });

  // Handles are stored as an opaque RSC-Flight-encoded string (see
  // handle-snapshot.ts encodeHandles), not a raw Record — the memory store keeps
  // the same encoded string by reference, identical to the JSON-serializing
  // stores, so both backends replay identical decoded values.
  const ENCODED_HANDLES = '1:{"layout":{"title":["My App"]}}';

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

    it("should handle empty handles string", async () => {
      const store = new MemorySegmentCacheStore();
      const data: CachedEntryData = {
        segments: [],
        handles: "",
        expiresAt: Date.now() + 60000,
      };

      await store.set("key", data, 60);
      const result = await store.get("key");

      expect(result!.data.handles).toBe("");
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
        handles: ENCODED_HANDLES,
        expiresAt: Date.now() + 60000,
      };

      await store.set("key", data, 60);
      const result = await store.get("key");

      expect(result!.data.segments).toHaveLength(2);
      expect(result!.data.handles).toBe(ENCODED_HANDLES);
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
        handles: "",
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
        handles: '1:{"日本語-segment":{"title":["こんにちは"]}}',
        expiresAt: Date.now() + 60000,
      };

      await store.set("key", data, 60);
      const result = await store.get("key");

      expect(result!.data.segments[0].metadata.id).toBe("日本語-segment");
      // The encoded handle string (unicode included) round-trips verbatim.
      expect(result!.data.handles).toBe(
        '1:{"日本語-segment":{"title":["こんにちは"]}}',
      );
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
        handles: "",
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
        handles: "",
        expiresAt: Date.now() + 60000,
      };

      await store.set("key", data, 60);
      const result = await store.get("key");

      expect(result!.data.segments).toEqual([]);
    });
  });

  // ==========================================================================
  // Function Cache Methods (getItem / setItem)
  // ==========================================================================

  describe("getItem/setItem", () => {
    it("should return null for missing key", async () => {
      const store = new MemorySegmentCacheStore();
      const result = await store.getItem("missing");
      expect(result).toBeNull();
    });

    it("should store and retrieve a value", async () => {
      const store = new MemorySegmentCacheStore();
      await store.setItem("fn:key", "serialized-value");
      const result = await store.getItem("fn:key");

      expect(result).not.toBeNull();
      expect(result!.value).toBe("serialized-value");
      expect(result!.shouldRevalidate).toBe(false);
    });

    it("should persist the encoded handle string alongside value", async () => {
      const store = new MemorySegmentCacheStore();

      await store.setItem("fn:with-handles", "value", {
        handles: ENCODED_HANDLES,
      });
      const result = await store.getItem("fn:with-handles");

      expect(result!.handles).toBe(ENCODED_HANDLES);
    });

    it("should use explicit TTL", async () => {
      vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));

      const store = new MemorySegmentCacheStore();
      await store.setItem("fn:ttl", "value", { ttl: 30 });

      vi.advanceTimersByTime(29 * 1000);
      expect(await store.getItem("fn:ttl")).not.toBeNull();

      vi.advanceTimersByTime(2 * 1000);
      expect(await store.getItem("fn:ttl")).toBeNull();
    });

    it("should fall back to store defaults for TTL", async () => {
      vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));

      const store = new MemorySegmentCacheStore({ defaults: { ttl: 10 } });
      await store.setItem("fn:default-ttl", "value");

      vi.advanceTimersByTime(9 * 1000);
      expect(await store.getItem("fn:default-ttl")).not.toBeNull();

      vi.advanceTimersByTime(2 * 1000);
      expect(await store.getItem("fn:default-ttl")).toBeNull();
    });

    it("should fall back to 900s TTL when no explicit or default TTL", async () => {
      vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));

      const store = new MemorySegmentCacheStore();
      await store.setItem("fn:fallback-ttl", "value");

      vi.advanceTimersByTime(899 * 1000);
      expect(await store.getItem("fn:fallback-ttl")).not.toBeNull();

      vi.advanceTimersByTime(2 * 1000);
      expect(await store.getItem("fn:fallback-ttl")).toBeNull();
    });

    it("should return shouldRevalidate=true when stale within SWR window", async () => {
      vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));

      const store = new MemorySegmentCacheStore();
      await store.setItem("fn:swr", "stale-value", { ttl: 60, swr: 300 });

      // Still fresh
      vi.advanceTimersByTime(30 * 1000);
      let result = await store.getItem("fn:swr");
      expect(result!.shouldRevalidate).toBe(false);

      // Past TTL, within SWR window — stale
      vi.advanceTimersByTime(60 * 1000);
      result = await store.getItem("fn:swr");
      expect(result!.shouldRevalidate).toBe(true);
      expect(result!.value).toBe("stale-value");
    });

    it("should expire after TTL + SWR window", async () => {
      vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));

      const store = new MemorySegmentCacheStore();
      await store.setItem("fn:expire", "value", { ttl: 60, swr: 300 });

      // Within SWR window — still returns data
      vi.advanceTimersByTime(350 * 1000);
      expect(await store.getItem("fn:expire")).not.toBeNull();

      // Past TTL + SWR — fully expired
      vi.advanceTimersByTime(20 * 1000);
      expect(await store.getItem("fn:expire")).toBeNull();
    });

    it("should use store defaults for SWR", async () => {
      vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));

      const store = new MemorySegmentCacheStore({
        defaults: { ttl: 60, swr: 120 },
      });
      await store.setItem("fn:default-swr", "value");

      // Past TTL, within default SWR
      vi.advanceTimersByTime(90 * 1000);
      const result = await store.getItem("fn:default-swr");
      expect(result!.shouldRevalidate).toBe(true);
      expect(result!.value).toBe("value");
    });

    it("should return shouldRevalidate=false when no SWR configured", async () => {
      vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));

      const store = new MemorySegmentCacheStore();
      await store.setItem("fn:no-swr", "value", { ttl: 60 });

      // Past TTL with no SWR — staleAt === expiresAt, immediately expired
      vi.advanceTimersByTime(61 * 1000);
      expect(await store.getItem("fn:no-swr")).toBeNull();
    });

    it("should delete expired items on getItem", async () => {
      vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));

      const store = new MemorySegmentCacheStore();
      await store.setItem("fn:gc", "value", { ttl: 5 });

      vi.advanceTimersByTime(6 * 1000);
      await store.getItem("fn:gc");

      // Verify internal cleanup by trying to get again
      expect(await store.getItem("fn:gc")).toBeNull();
    });

    it("should be cleared by clear()", async () => {
      const store = new MemorySegmentCacheStore();
      await store.setItem("fn:clear-test", "value");

      await store.clear();

      expect(await store.getItem("fn:clear-test")).toBeNull();
    });
  });

  // ==========================================================================
  // Response Cache Methods (getResponse / putResponse)
  // ==========================================================================

  describe("getResponse/putResponse", () => {
    it("should return null for missing key", async () => {
      const store = new MemorySegmentCacheStore();
      const result = await store.getResponse("missing");
      expect(result).toBeNull();
    });

    it("should store and retrieve a response", async () => {
      const store = new MemorySegmentCacheStore();
      const response = new Response("hello", {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      });

      await store.putResponse("doc:key", response, 60);
      const result = await store.getResponse("doc:key");

      expect(result).not.toBeNull();
      expect(result!.response.status).toBe(200);
      expect(await result!.response.text()).toBe("hello");
      expect(result!.response.headers.get("Content-Type")).toBe("text/plain");
    });

    it("should return shouldRevalidate=false for fresh responses", async () => {
      vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));

      const store = new MemorySegmentCacheStore();
      await store.putResponse("doc:fresh", new Response("ok"), 60, 300);

      vi.advanceTimersByTime(30 * 1000);
      const result = await store.getResponse("doc:fresh");
      expect(result!.shouldRevalidate).toBe(false);
    });

    it("should return shouldRevalidate=true for stale responses within SWR", async () => {
      vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));

      const store = new MemorySegmentCacheStore();
      await store.putResponse("doc:stale", new Response("stale-body"), 60, 300);

      // Past TTL, within SWR
      vi.advanceTimersByTime(120 * 1000);
      const result = await store.getResponse("doc:stale");
      expect(result!.shouldRevalidate).toBe(true);
      expect(await result!.response.text()).toBe("stale-body");
    });

    it("should expire after TTL + SWR", async () => {
      vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));

      const store = new MemorySegmentCacheStore();
      await store.putResponse("doc:expire", new Response("body"), 60, 300);

      vi.advanceTimersByTime(361 * 1000);
      expect(await store.getResponse("doc:expire")).toBeNull();
    });

    it("should use store defaults for SWR", async () => {
      vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));

      const store = new MemorySegmentCacheStore({ defaults: { swr: 120 } });
      await store.putResponse("doc:default-swr", new Response("body"), 60);

      // Past TTL, within default SWR
      vi.advanceTimersByTime(90 * 1000);
      const result = await store.getResponse("doc:default-swr");
      expect(result!.shouldRevalidate).toBe(true);
    });

    it("should preserve multiple headers", async () => {
      const store = new MemorySegmentCacheStore();
      const response = new Response("body", {
        status: 200,
        headers: {
          "Content-Type": "text/html",
          "X-Custom": "value",
        },
      });

      await store.putResponse("doc:headers", response, 60);
      const result = await store.getResponse("doc:headers");

      expect(result!.response.headers.get("Content-Type")).toBe("text/html");
      expect(result!.response.headers.get("X-Custom")).toBe("value");
    });

    it("should be cleared by clear()", async () => {
      const store = new MemorySegmentCacheStore();
      await store.putResponse("doc:clear-test", new Response("body"), 60);

      await store.clear();

      expect(await store.getResponse("doc:clear-test")).toBeNull();
    });
  });
});
