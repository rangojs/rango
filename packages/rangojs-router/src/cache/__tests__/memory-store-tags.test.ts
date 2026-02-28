import { describe, it, expect, beforeEach } from "vitest";
import { MemorySegmentCacheStore } from "../memory-segment-store.js";

describe("MemorySegmentCacheStore tag invalidation", () => {
  let store: MemorySegmentCacheStore;

  beforeEach(() => {
    MemorySegmentCacheStore.resetGlobalCache();
    store = new MemorySegmentCacheStore();
  });

  describe("setItem + revalidateTag", () => {
    it("deletes tagged item cache entries", async () => {
      await store.setItem("key1", "value1", {
        ttl: 60,
        tags: ["products"],
      });
      await store.setItem("key2", "value2", {
        ttl: 60,
        tags: ["products", "featured"],
      });
      await store.setItem("key3", "value3", { ttl: 60 });

      await store.revalidateTag("products");

      expect(await store.getItem("key1")).toBeNull();
      expect(await store.getItem("key2")).toBeNull();
      expect(await store.getItem("key3")).not.toBeNull();
    });

    it("is a no-op for unknown tag", async () => {
      await store.setItem("key1", "value1", { ttl: 60, tags: ["keep"] });

      await store.revalidateTag("nonexistent");

      expect(await store.getItem("key1")).not.toBeNull();
    });
  });

  describe("set (segment) + revalidateTag", () => {
    it("deletes tagged segment cache entries", async () => {
      await store.set(
        "seg-key1",
        {
          segments: [],
          handles: {},
          expiresAt: Date.now() + 60000,
          tags: ["page"],
        },
        60,
      );
      await store.set(
        "seg-key2",
        {
          segments: [],
          handles: {},
          expiresAt: Date.now() + 60000,
        },
        60,
      );

      await store.revalidateTag("page");

      expect(await store.get("seg-key1")).toBeNull();
      expect(await store.get("seg-key2")).not.toBeNull();
    });
  });

  describe("putResponse + revalidateTag", () => {
    it("deletes tagged response cache entries", async () => {
      await store.putResponse(
        "res-key1",
        new Response("body1"),
        60,
        undefined,
        ["api"],
      );
      await store.putResponse("res-key2", new Response("body2"), 60);

      await store.revalidateTag("api");

      expect(await store.getResponse("res-key1")).toBeNull();
      expect(await store.getResponse("res-key2")).not.toBeNull();
    });
  });

  describe("cross-type invalidation", () => {
    it("deletes entries across all cache types for same tag", async () => {
      await store.set(
        "seg-key",
        {
          segments: [],
          handles: {},
          expiresAt: Date.now() + 60000,
          tags: ["shared-tag"],
        },
        60,
      );
      await store.putResponse("res-key", new Response("body"), 60, undefined, [
        "shared-tag",
      ]);
      await store.setItem("item-key", "value", {
        ttl: 60,
        tags: ["shared-tag"],
      });

      await store.revalidateTag("shared-tag");

      expect(await store.get("seg-key")).toBeNull();
      expect(await store.getResponse("res-key")).toBeNull();
      expect(await store.getItem("item-key")).toBeNull();
    });
  });

  describe("tag cleanup on key overwrite", () => {
    it("does not invalidate new entry when old tag is revalidated", async () => {
      await store.setItem("key1", "old-value", {
        ttl: 60,
        tags: ["old-tag"],
      });
      // Overwrite same key with a different tag
      await store.setItem("key1", "new-value", {
        ttl: 60,
        tags: ["new-tag"],
      });

      // Revalidating old tag should NOT delete the new entry
      await store.revalidateTag("old-tag");

      const cached = await store.getItem("key1");
      expect(cached).not.toBeNull();
      expect(cached!.value).toBe("new-value");
    });

    it("cleans up stale segment tag mappings on overwrite", async () => {
      await store.set(
        "seg-key",
        {
          segments: [],
          handles: {},
          expiresAt: Date.now() + 60000,
          tags: ["old"],
        },
        60,
      );
      await store.set(
        "seg-key",
        {
          segments: [],
          handles: {},
          expiresAt: Date.now() + 60000,
          tags: ["new"],
        },
        60,
      );

      await store.revalidateTag("old");
      expect(await store.get("seg-key")).not.toBeNull();

      await store.revalidateTag("new");
      expect(await store.get("seg-key")).toBeNull();
    });

    it("cleans up stale response tag mappings on overwrite", async () => {
      await store.putResponse("res-key", new Response("v1"), 60, undefined, [
        "old",
      ]);
      await store.putResponse("res-key", new Response("v2"), 60, undefined, [
        "new",
      ]);

      await store.revalidateTag("old");
      expect(await store.getResponse("res-key")).not.toBeNull();

      await store.revalidateTag("new");
      expect(await store.getResponse("res-key")).toBeNull();
    });
  });

  describe("clear cleans tag index", () => {
    it("entries are gone after clear", async () => {
      await store.setItem("key1", "value1", {
        ttl: 60,
        tags: ["tag1"],
      });

      await store.clear();

      expect(await store.getItem("key1")).toBeNull();
    });
  });
});
