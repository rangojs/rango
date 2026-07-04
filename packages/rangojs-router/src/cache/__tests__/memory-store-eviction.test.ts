/**
 * C4: MemorySegmentCacheStore per-family FIFO cap (maxEntries).
 *
 * A long-lived instance must not grow unbounded. Each internal family (segment,
 * response, item, shell) is capped at maxEntries with insertion-order (FIFO)
 * eviction on insert, and eviction also unregisters the evicted key's tags so
 * the tag index does not outlive the capped data map. Lazy TTL expiry is
 * unchanged.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { MemorySegmentCacheStore } from "../memory-segment-store.js";
import type { CachedEntryData } from "../types.js";

function seg(tags?: string[]): CachedEntryData {
  return {
    segments: [],
    handles: "",
    expiresAt: Date.now() + 60_000,
    ...(tags ? { tags } : {}),
  };
}

describe("MemorySegmentCacheStore maxEntries FIFO cap (C4)", () => {
  beforeEach(() => {
    MemorySegmentCacheStore.resetGlobalCache();
  });

  it("defaults maxEntries to 1000", () => {
    expect(new MemorySegmentCacheStore().maxEntries).toBe(1000);
  });

  it("accepts a custom maxEntries", () => {
    expect(new MemorySegmentCacheStore({ maxEntries: 5 }).maxEntries).toBe(5);
  });

  it("caps the segment family and evicts the oldest on insert (FIFO)", async () => {
    const store = new MemorySegmentCacheStore({ maxEntries: 2 });
    await store.set("A", seg(), 60);
    await store.set("B", seg(), 60);
    await store.set("C", seg(), 60); // evicts A (oldest)

    expect(store.getStats().size).toBe(2);
    expect(await store.get("A")).toBeNull();
    expect(await store.get("B")).not.toBeNull();
    expect(await store.get("C")).not.toBeNull();
  });

  it("caps the item family independently", async () => {
    const store = new MemorySegmentCacheStore({ maxEntries: 2 });
    await store.setItem("a", "1", { ttl: 60 });
    await store.setItem("b", "2", { ttl: 60 });
    await store.setItem("c", "3", { ttl: 60 }); // evicts a

    expect(await store.getItem("a")).toBeNull();
    expect((await store.getItem("b"))?.value).toBe("2");
    expect((await store.getItem("c"))?.value).toBe("3");
  });

  it("overwriting an existing key does not evict (no size growth)", async () => {
    const store = new MemorySegmentCacheStore({ maxEntries: 2 });
    await store.set("A", seg(), 60);
    await store.set("B", seg(), 60);
    await store.set("A", seg(), 60); // overwrite, not a new key

    expect(store.getStats().size).toBe(2);
    expect(await store.get("A")).not.toBeNull();
    expect(await store.get("B")).not.toBeNull();
  });

  it("eviction unregisters the evicted key's tags (no tag-index leak)", async () => {
    const store = new MemorySegmentCacheStore({ maxEntries: 2 });
    // A carries tag "ta"; it will be FIFO-evicted when C is inserted.
    await store.setItem("A", "va", { ttl: 60, tags: ["ta"] });
    await store.setItem("B", "vb", { ttl: 60, tags: ["tb"] });
    await store.setItem("C", "vc", { ttl: 60, tags: ["tc"] }); // evicts A
    expect(await store.getItem("A")).toBeNull();

    // Reuse A's key for a fresh, UNTAGGED entry (this evicts B).
    await store.setItem("A", "fresh", { ttl: 60 });

    // If eviction had left "ta" -> item:A in the tag index, this would delete
    // the fresh A entry. It must survive because the stale mapping was cleaned.
    await store.invalidateTags(["ta"]);
    const cached = await store.getItem("A");
    expect(cached).not.toBeNull();
    expect(cached!.value).toBe("fresh");
  });

  it("caps the response and shell families too", async () => {
    const store = new MemorySegmentCacheStore({ maxEntries: 1 });

    await store.putResponse("r1", new Response("1"), 60);
    await store.putResponse("r2", new Response("2"), 60); // evicts r1
    expect(await store.getResponse("r1")).toBeNull();
    expect(await store.getResponse("r2")).not.toBeNull();

    const shell = {
      prelude: btoa("SHELL"),
      postponed: null,
      reactVersion: "19.2.6",
      createdAt: Date.now(),
    };
    await store.putShell("s1", shell, 60);
    await store.putShell("s2", shell, 60); // evicts s1
    expect(await store.getShell("s1")).toBeNull();
    expect(await store.getShell("s2")).not.toBeNull();
  });
});
