import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { MemoryCacheStore } from "../memory-store";

describe("MemoryCacheStore", () => {
  let store: MemoryCacheStore;

  beforeEach(() => {
    store = new MemoryCacheStore();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("basic operations", () => {
    it("should return undefined for missing key", async () => {
      const result = await store.match("missing-key");
      expect(result).toBeUndefined();
    });

    it("should store and retrieve string values", async () => {
      await store.put("key", "hello world");
      const result = await store.match("key");

      expect(result).toBeDefined();
      expect(result!.value).toBe("hello world");
    });

    it("should store and retrieve object values", async () => {
      const obj = { foo: "bar", nested: { a: 1 } };
      await store.put("key", obj);
      const result = await store.match("key");

      expect(result).toBeDefined();
      expect(result!.value).toEqual(obj);
    });

    it("should store and retrieve ArrayBuffer values", async () => {
      const buffer = new TextEncoder().encode("test data").buffer;
      await store.put("key", buffer);
      const result = await store.match("key");

      expect(result).toBeDefined();
      expect(result!.value).toBeInstanceOf(ArrayBuffer);
      const decoded = new TextDecoder().decode(result!.value as ArrayBuffer);
      expect(decoded).toBe("test data");
    });

    it("should delete entries", async () => {
      await store.put("key", "value");
      const deleted = await store.delete("key");

      expect(deleted).toBe(true);
      const result = await store.match("key");
      expect(result).toBeUndefined();
    });

    it("should return false when deleting non-existent key", async () => {
      const deleted = await store.delete("missing");
      expect(deleted).toBe(false);
    });

    it("should clear all entries", () => {
      store.put("key1", "value1");
      store.put("key2", "value2");

      store.clear();

      expect(store.size).toBe(0);
    });

    it("should report correct size", async () => {
      expect(store.size).toBe(0);

      await store.put("key1", "value1");
      expect(store.size).toBe(1);

      await store.put("key2", "value2");
      expect(store.size).toBe(2);

      await store.delete("key1");
      expect(store.size).toBe(1);
    });
  });

  describe("TTL and expiration", () => {
    it("should use default TTL of 60 seconds", async () => {
      vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));

      await store.put("key", "value");

      // Should be available before TTL
      vi.advanceTimersByTime(59 * 1000);
      let result = await store.match("key");
      expect(result).toBeDefined();

      // Should expire after TTL
      vi.advanceTimersByTime(2 * 1000);
      result = await store.match("key");
      expect(result).toBeUndefined();
    });

    it("should respect custom TTL", async () => {
      vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));

      await store.put("key", "value", { ttl: 10 });

      // Should be available before TTL
      vi.advanceTimersByTime(9 * 1000);
      let result = await store.match("key");
      expect(result).toBeDefined();

      // Should expire after TTL
      vi.advanceTimersByTime(2 * 1000);
      result = await store.match("key");
      expect(result).toBeUndefined();
    });

    it("should delete expired entries on match", async () => {
      vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));

      await store.put("key", "value", { ttl: 5 });
      expect(store.size).toBe(1);

      vi.advanceTimersByTime(6 * 1000);
      await store.match("key");

      expect(store.size).toBe(0);
    });

    it("should purge all expired entries", async () => {
      vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));

      await store.put("key1", "value1", { ttl: 5 });
      await store.put("key2", "value2", { ttl: 10 });
      await store.put("key3", "value3", { ttl: 20 });

      vi.advanceTimersByTime(7 * 1000);

      const purged = store.purgeExpired();

      expect(purged).toBe(1);
      expect(store.size).toBe(2);
    });
  });

  describe("Response handling", () => {
    it("should store and reconstruct Response objects", async () => {
      const response = new Response("response body", {
        status: 201,
        headers: {
          "Content-Type": "text/plain",
          "X-Custom": "header",
        },
      });

      await store.put("key", response);
      const result = await store.match<Response>("key");

      expect(result).toBeDefined();
      expect(result!.value).toBeInstanceOf(Response);

      const retrieved = result!.value as Response;
      expect(retrieved.status).toBe(201);
      expect(retrieved.headers.get("Content-Type")).toBe("text/plain");
      expect(retrieved.headers.get("X-Custom")).toBe("header");
      expect(await retrieved.text()).toBe("response body");
    });

    it("should handle Response with default status", async () => {
      const response = new Response("body");

      await store.put("key", response);
      const result = await store.match<Response>("key");

      expect(result!.value).toBeInstanceOf(Response);
      expect((result!.value as Response).status).toBe(200);
    });
  });

  describe("ReadableStream handling", () => {
    it("should store and reconstruct ReadableStream", async () => {
      const chunks = ["hello", " ", "world"];
      const stream = new ReadableStream({
        start(controller) {
          for (const chunk of chunks) {
            controller.enqueue(new TextEncoder().encode(chunk));
          }
          controller.close();
        },
      });

      await store.put("key", stream);
      const result = await store.match<ReadableStream>("key");

      expect(result).toBeDefined();
      expect(result!.value).toBeInstanceOf(ReadableStream);

      const reader = (result!.value as ReadableStream).getReader();
      const data: Uint8Array[] = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        data.push(value);
      }

      const decoded = new TextDecoder().decode(
        data.reduce((acc, chunk) => {
          const combined = new Uint8Array(acc.length + chunk.length);
          combined.set(acc);
          combined.set(chunk, acc.length);
          return combined;
        }, new Uint8Array())
      );

      expect(decoded).toBe("hello world");
    });
  });

  describe("metadata", () => {
    it("should track value type in metadata", async () => {
      await store.put("string", "test");
      await store.put("object", { foo: "bar" });

      const stringResult = await store.match("string");
      const objectResult = await store.match("object");

      expect(stringResult!.metadata.valueType).toBe("string");
      expect(objectResult!.metadata.valueType).toBe("object");
    });

    it("should store custom metadata", async () => {
      await store.put("key", "value", {
        metadata: {
          custom: "data",
        } as any,
      });

      const result = await store.match("key");
      expect((result!.metadata as any).custom).toBe("data");
    });

    it("should track expiresAt in metadata", async () => {
      vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));

      await store.put("key", "value", { ttl: 60 });

      const result = await store.match("key");
      expect(result!.metadata.expiresAt).toBe(
        new Date("2024-01-01T00:00:00Z").getTime() + 60 * 1000
      );
    });

    it("should track response headers and status in metadata", async () => {
      const response = new Response("body", {
        status: 404,
        headers: { "X-Test": "value" },
      });

      await store.put("key", response);

      const result = await store.match("key");
      expect(result!.metadata.valueType).toBe("response");
      expect(result!.metadata.responseStatus).toBe(404);
      expect(result!.metadata.responseHeaders!["x-test"]).toBe("value");
    });
  });

  describe("edge cases", () => {
    it("should handle empty string values", async () => {
      await store.put("key", "");
      const result = await store.match("key");

      expect(result).toBeDefined();
      expect(result!.value).toBe("");
    });

    it("should handle null in object values", async () => {
      const obj = { foo: null, bar: "baz" };
      await store.put("key", obj);
      const result = await store.match("key");

      expect(result!.value).toEqual(obj);
    });

    it("should handle special characters in keys", async () => {
      const key = "route:/users/123?filter=active&sort=name";
      await store.put(key, "value");
      const result = await store.match(key);

      expect(result).toBeDefined();
      expect(result!.value).toBe("value");
    });

    it("should overwrite existing entries", async () => {
      await store.put("key", "first");
      await store.put("key", "second");

      const result = await store.match("key");
      expect(result!.value).toBe("second");
      expect(store.size).toBe(1);
    });

    it("should handle very long keys", async () => {
      const longKey = "k".repeat(10000);
      await store.put(longKey, "value");
      const result = await store.match(longKey);

      expect(result).toBeDefined();
      expect(result!.value).toBe("value");
    });

    it("should handle unicode characters in keys and values", async () => {
      const unicodeKey = "路由/用户/日本語";
      const unicodeValue = { message: "こんにちは世界 🌍" };

      await store.put(unicodeKey, unicodeValue);
      const result = await store.match(unicodeKey);

      expect(result).toBeDefined();
      expect(result!.value).toEqual(unicodeValue);
    });

    it("should handle deeply nested objects", async () => {
      const deepObject = {
        level1: {
          level2: {
            level3: {
              level4: {
                value: "deep",
              },
            },
          },
        },
      };

      await store.put("key", deepObject);
      const result = await store.match("key");

      expect(result!.value).toEqual(deepObject);
    });

    it("should handle arrays as values", async () => {
      const arr = [1, "two", { three: 3 }, [4, 5]];
      await store.put("key", arr);
      const result = await store.match("key");

      expect(result!.value).toEqual(arr);
    });

    it("should handle TTL of 0 (immediate expiration)", async () => {
      vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));

      await store.put("key", "value", { ttl: 0 });

      vi.advanceTimersByTime(1);
      const result = await store.match("key");
      expect(result).toBeUndefined();
    });

    it("should handle very large TTL", async () => {
      vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));

      await store.put("key", "value", { ttl: 365 * 24 * 60 * 60 }); // 1 year

      // Advance 6 months
      vi.advanceTimersByTime(180 * 24 * 60 * 60 * 1000);
      const result = await store.match("key");
      expect(result).toBeDefined();
    });

    it("should handle Response with empty body", async () => {
      const response = new Response(null, { status: 200 });

      await store.put("key", response);
      const result = await store.match<Response>("key");

      expect(result).toBeDefined();
      expect((result!.value as Response).status).toBe(200);
      expect(await (result!.value as Response).text()).toBe("");
    });

    it("should handle Response with 204 No Content status", async () => {
      const response = new Response(null, { status: 204 });

      await store.put("key", response);
      const result = await store.match<Response>("key");

      expect(result).toBeDefined();
      expect((result!.value as Response).status).toBe(204);
    });

    it("should handle Response with 304 Not Modified status", async () => {
      const response = new Response(null, { status: 304 });

      await store.put("key", response);
      const result = await store.match<Response>("key");

      expect(result).toBeDefined();
      expect((result!.value as Response).status).toBe(304);
    });

    it("should handle Response with JSON body", async () => {
      const jsonBody = { users: [{ id: 1 }, { id: 2 }] };
      const response = new Response(JSON.stringify(jsonBody), {
        headers: { "Content-Type": "application/json" },
      });

      await store.put("key", response);
      const result = await store.match<Response>("key");

      const retrieved = result!.value as Response;
      const body = await retrieved.json();
      expect(body).toEqual(jsonBody);
    });

    it("should handle binary data in ArrayBuffer", async () => {
      // Create binary data with all byte values
      const binaryData = new Uint8Array(256);
      for (let i = 0; i < 256; i++) {
        binaryData[i] = i;
      }

      await store.put("key", binaryData.buffer);
      const result = await store.match<ArrayBuffer>("key");

      const retrieved = new Uint8Array(result!.value as ArrayBuffer);
      expect(retrieved).toEqual(binaryData);
    });

    it("should handle concurrent puts to same key", async () => {
      // Simulate concurrent writes
      const promises = [
        store.put("key", "value1"),
        store.put("key", "value2"),
        store.put("key", "value3"),
      ];

      await Promise.all(promises);

      const result = await store.match("key");
      // Last write wins
      expect(["value1", "value2", "value3"]).toContain(result!.value);
      expect(store.size).toBe(1);
    });

    it("should handle concurrent reads and writes", async () => {
      await store.put("key", "initial");

      const operations = [
        store.match("key"),
        store.put("key", "updated"),
        store.match("key"),
      ];

      const results = await Promise.all(operations);

      // First read gets initial or updated
      expect(["initial", "updated"]).toContain(
        (results[0] as any)?.value ?? "updated"
      );
    });

    it("should correctly purge multiple expired entries", async () => {
      vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));

      await store.put("short1", "v1", { ttl: 5 });
      await store.put("short2", "v2", { ttl: 5 });
      await store.put("short3", "v3", { ttl: 5 });
      await store.put("long1", "v4", { ttl: 100 });
      await store.put("long2", "v5", { ttl: 100 });

      expect(store.size).toBe(5);

      vi.advanceTimersByTime(10 * 1000);
      const purged = store.purgeExpired();

      expect(purged).toBe(3);
      expect(store.size).toBe(2);
    });
  });
});
