import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { MemorySegmentCacheStore } from "../memory-segment-store.js";

describe("MemorySegmentCacheStore tag invalidation", () => {
  let store: MemorySegmentCacheStore;

  beforeEach(() => {
    MemorySegmentCacheStore.resetGlobalCache();
    store = new MemorySegmentCacheStore();
  });

  describe("setItem + invalidateTag", () => {
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

      await store.invalidateTags(["products"]);

      expect(await store.getItem("key1")).toBeNull();
      expect(await store.getItem("key2")).toBeNull();
      expect(await store.getItem("key3")).not.toBeNull();
    });

    it("is a no-op for unknown tag", async () => {
      await store.setItem("key1", "value1", { ttl: 60, tags: ["keep"] });

      await store.invalidateTags(["nonexistent"]);

      expect(await store.getItem("key1")).not.toBeNull();
    });
  });

  describe("set (segment) + invalidateTag", () => {
    it("deletes tagged segment cache entries", async () => {
      await store.set(
        "seg-key1",
        {
          segments: [],
          handles: "",
          expiresAt: Date.now() + 60000,
          tags: ["page"],
        },
        60,
      );
      await store.set(
        "seg-key2",
        {
          segments: [],
          handles: "",
          expiresAt: Date.now() + 60000,
        },
        60,
      );

      await store.invalidateTags(["page"]);

      expect(await store.get("seg-key1")).toBeNull();
      expect(await store.get("seg-key2")).not.toBeNull();
    });
  });

  describe("putResponse + invalidateTag", () => {
    it("deletes tagged response cache entries", async () => {
      await store.putResponse(
        "res-key1",
        new Response("body1"),
        60,
        undefined,
        ["api"],
      );
      await store.putResponse("res-key2", new Response("body2"), 60);

      await store.invalidateTags(["api"]);

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
          handles: "",
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

      await store.invalidateTags(["shared-tag"]);

      expect(await store.get("seg-key")).toBeNull();
      expect(await store.getResponse("res-key")).toBeNull();
      expect(await store.getItem("item-key")).toBeNull();
    });
  });

  describe("colon-containing keys (real-shaped)", () => {
    it("round-trips a key that itself contains colons", async () => {
      // Real cache keys contain colons (use-cache:id:args, doc:host/path). The
      // prefixed key (item:<key>) is split on the FIRST colon to recover the
      // cache type; a refactor to lastIndexOf would silently break this. Pin it.
      const key = "use-cache:getProduct:[42]";
      await store.setItem(key, "v", { ttl: 60, tags: ["products"] });
      expect(await store.getItem(key)).not.toBeNull();

      await store.invalidateTags(["products"]);
      expect(await store.getItem(key)).toBeNull();
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
      await store.invalidateTags(["old-tag"]);

      const cached = await store.getItem("key1");
      expect(cached).not.toBeNull();
      expect(cached!.value).toBe("new-value");
    });

    it("cleans up stale segment tag mappings on overwrite", async () => {
      await store.set(
        "seg-key",
        {
          segments: [],
          handles: "",
          expiresAt: Date.now() + 60000,
          tags: ["old"],
        },
        60,
      );
      await store.set(
        "seg-key",
        {
          segments: [],
          handles: "",
          expiresAt: Date.now() + 60000,
          tags: ["new"],
        },
        60,
      );

      await store.invalidateTags(["old"]);
      expect(await store.get("seg-key")).not.toBeNull();

      await store.invalidateTags(["new"]);
      expect(await store.get("seg-key")).toBeNull();
    });

    it("cleans up stale response tag mappings on overwrite", async () => {
      await store.putResponse("res-key", new Response("v1"), 60, undefined, [
        "old",
      ]);
      await store.putResponse("res-key", new Response("v2"), 60, undefined, [
        "new",
      ]);

      await store.invalidateTags(["old"]);
      expect(await store.getResponse("res-key")).not.toBeNull();

      await store.invalidateTags(["new"]);
      expect(await store.getResponse("res-key")).toBeNull();
    });
  });

  describe("tagged -> untagged overwrite", () => {
    it("does not invalidate untagged item after old tag revalidation", async () => {
      await store.setItem("key1", "old-value", {
        ttl: 60,
        tags: ["old-tag"],
      });
      // Overwrite with no tags
      await store.setItem("key1", "new-value", { ttl: 60 });

      await store.invalidateTags(["old-tag"]);

      const cached = await store.getItem("key1");
      expect(cached).not.toBeNull();
      expect(cached!.value).toBe("new-value");
    });

    it("does not invalidate untagged segment after old tag revalidation", async () => {
      await store.set(
        "seg-key",
        {
          segments: [],
          handles: "",
          expiresAt: Date.now() + 60000,
          tags: ["old"],
        },
        60,
      );
      await store.set(
        "seg-key",
        { segments: [], handles: "", expiresAt: Date.now() + 60000 },
        60,
      );

      await store.invalidateTags(["old"]);
      expect(await store.get("seg-key")).not.toBeNull();
    });

    it("does not invalidate untagged response after old tag revalidation", async () => {
      await store.putResponse("res-key", new Response("v1"), 60, undefined, [
        "old",
      ]);
      await store.putResponse("res-key", new Response("v2"), 60);

      await store.invalidateTags(["old"]);
      expect(await store.getResponse("res-key")).not.toBeNull();
    });
  });

  describe("delete cleans up tag index", () => {
    it("does not invalidate new entry written after delete", async () => {
      await store.set(
        "seg-key",
        {
          segments: [],
          handles: "",
          expiresAt: Date.now() + 60000,
          tags: ["tag-a"],
        },
        60,
      );
      await store.delete("seg-key");

      // Write a new untagged entry under the same key
      await store.set(
        "seg-key",
        { segments: [], handles: "", expiresAt: Date.now() + 60000 },
        60,
      );

      await store.invalidateTags(["tag-a"]);
      expect(await store.get("seg-key")).not.toBeNull();
    });
  });

  describe("expiry cleanup removes tag index", () => {
    it("does not invalidate new item written after expiry eviction", async () => {
      vi.useFakeTimers();
      try {
        await store.setItem("key1", "old", {
          ttl: 1,
          tags: ["stale-tag"],
        });

        // Advance past TTL to trigger expiry eviction
        vi.advanceTimersByTime(2000);
        expect(await store.getItem("key1")).toBeNull();

        // Write a new untagged entry under the same key
        await store.setItem("key1", "fresh", { ttl: 60 });

        await store.invalidateTags(["stale-tag"]);
        const cached = await store.getItem("key1");
        expect(cached).not.toBeNull();
        expect(cached!.value).toBe("fresh");
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("multi-tag stale references after partial revalidation", () => {
    it("revalidating one tag cleans up other tag references for the same key", async () => {
      await store.setItem("key1", "value1", {
        ttl: 60,
        tags: ["tag-a", "tag-b"],
      });

      // Revalidate only tag-a — this deletes key1
      await store.invalidateTags(["tag-a"]);
      expect(await store.getItem("key1")).toBeNull();

      // Write a new untagged entry under the same key
      await store.setItem("key1", "value2", { ttl: 60 });

      // tag-b should no longer reference the old key
      await store.invalidateTags(["tag-b"]);
      const cached = await store.getItem("key1");
      expect(cached).not.toBeNull();
      expect(cached!.value).toBe("value2");
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

    it("clear() also drops the tag index, so a reused key is not over-invalidated", async () => {
      await store.setItem("key1", "value1", { ttl: 60, tags: ["tag1"] });
      await store.clear();

      // Reuse the key for a fresh, untagged entry after clear().
      await store.setItem("key1", "value2", { ttl: 60 });

      // If clear() left the tag index behind, invalidating the old tag would
      // wrongly delete the new entry. It must survive.
      await store.invalidateTags(["tag1"]);
      const cached = await store.getItem("key1");
      expect(cached).not.toBeNull();
      expect(cached!.value).toBe("value2");
    });

    it("clear() drops build-shell invalidation markers", async () => {
      const beforeInvalidation = Date.now();
      await store.invalidateTags(["home"]);
      expect(
        await store.isTagsInvalidatedSince(["home"], beforeInvalidation),
      ).toBe(true);

      await store.clear();
      expect(
        await store.isTagsInvalidatedSince(["home"], beforeInvalidation),
      ).toBe(false);
    });
  });

  // The build-shell read-through's eviction gate (#699): a baked manifest
  // entry is immutable, so updateTag reaches it by MARKER comparison —
  // isTagsInvalidatedSince(tags, entry.createdAt) — not by deletion.
  describe("isTagsInvalidatedSince (build-shell markers)", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("reports an invalidation at or after `since` (>= — same-ms wins)", async () => {
      const t0 = Date.now();
      await store.invalidateTags(["home"]);
      expect(await store.isTagsInvalidatedSince(["home"], t0)).toBe(true);
      // Strictly-later reference instant: the marker predates it.
      expect(await store.isTagsInvalidatedSince(["home"], t0 + 1)).toBe(false);
    });

    it("returns false for never-invalidated tags", async () => {
      expect(await store.isTagsInvalidatedSince(["absent"], 0)).toBe(false);
    });

    it("any one invalidated tag of the set suffices", async () => {
      const t0 = Date.now();
      await store.invalidateTags(["b"]);
      expect(await store.isTagsInvalidatedSince(["a", "b", "c"], t0)).toBe(
        true,
      );
    });

    it("marks the tag even when no runtime entry currently carries it", async () => {
      // The tagIndex has no bucket for this tag — the marker must land anyway
      // (build-shell entries live in the manifest, not the store).
      const t0 = Date.now();
      await store.invalidateTags(["manifest-only-tag"]);
      expect(
        await store.isTagsInvalidatedSince(["manifest-only-tag"], t0),
      ).toBe(true);
    });
  });
});
