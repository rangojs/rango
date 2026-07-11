import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React from "react";
import { MemorySegmentCacheStore } from "../memory-segment-store.js";
import type { ShellCacheEntry } from "../types.js";

// The shell STORE family (getShell/putShell) unit contract. Serving/capture moved
// into the integrated render path (rsc/shell-serve.ts + rsc/rsc-rendering.ts --
// tested in src/rsc/__tests__/rsc-rendering-shell-ppr.test.ts); the store family
// remains a public SegmentCacheStore extension implemented by the memory, CF, and
// Vercel stores, and this file pins its semantics against the memory store.

const REACT_VERSION = React.version;

/** A minimal shell entry with the current React version (a valid hit). */
function shellEntry(overrides: Partial<ShellCacheEntry> = {}): ShellCacheEntry {
  return {
    prelude: btoa("<html><body>SHELL</body></html>"),
    postponed: JSON.stringify({ hole: 1 }),
    reactVersion: REACT_VERSION,
    buildVersion: "build-abc",
    createdAt: Date.now(),
    ...overrides,
  };
}

describe("MemorySegmentCacheStore shell family", () => {
  const T0 = new Date("2024-01-01T00:00:00Z").getTime();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(T0));
  });
  afterEach(() => vi.useRealTimers());

  it("round-trips a shell entry", async () => {
    const store = new MemorySegmentCacheStore();
    const entry = shellEntry();
    await store.putShell("k", entry, 300, 30);
    const hit = await store.getShell("k");
    expect(hit).not.toBeNull();
    expect(hit?.entry).toEqual(entry);
    expect(hit?.shouldRevalidate).toBe(false);
  });

  it("returns null on a miss", async () => {
    const store = new MemorySegmentCacheStore();
    expect(await store.getShell("absent")).toBeNull();
  });

  it("is fresh before staleAt, stale (shouldRevalidate) within the SWR window, gone after expiry", async () => {
    const store = new MemorySegmentCacheStore();
    await store.putShell("k", shellEntry(), 60, 300); // stale +60s, expire +360s

    vi.setSystemTime(new Date(T0 + 30_000));
    expect((await store.getShell("k"))?.shouldRevalidate).toBe(false);

    vi.setSystemTime(new Date(T0 + 120_000));
    expect((await store.getShell("k"))?.shouldRevalidate).toBe(true);

    vi.setSystemTime(new Date(T0 + 400_000));
    expect(await store.getShell("k")).toBeNull();
  });

  it("is invalidated by tag", async () => {
    const store = new MemorySegmentCacheStore();
    await store.putShell("k", shellEntry(), 300, 30, ["home"]);
    expect(await store.getShell("k")).not.toBeNull();
    await store.invalidateTags(["home"]);
    expect(await store.getShell("k")).toBeNull();
  });

  it("does not resurrect a shell captured before tag invalidation", async () => {
    const store = new MemorySegmentCacheStore();
    const captured = shellEntry({ createdAt: T0 });
    vi.setSystemTime(new Date(T0 + 1));
    await store.invalidateTags(["home"]);
    expect(await store.putShell("k", captured, 300, 30, ["home"])).toBe(
      "invalidated",
    );

    expect(await store.getShell("k")).toBeNull();
  });

  it("does not delete a newer shell when an older capture is rejected", async () => {
    const store = new MemorySegmentCacheStore();
    vi.setSystemTime(new Date(T0 + 1));
    await store.invalidateTags(["home"]);
    vi.setSystemTime(new Date(T0 + 2));
    await store.putShell(
      "k",
      shellEntry({ prelude: "new", createdAt: T0 + 2 }),
      300,
      30,
      ["home"],
    );
    await store.putShell(
      "k",
      shellEntry({ prelude: "old", createdAt: T0 }),
      300,
      30,
      ["home"],
    );

    expect((await store.getShell("k"))?.entry.prelude).toBe("new");
  });

  it("keeps the shell family isolated from the response/item families on the same key", async () => {
    const store = new MemorySegmentCacheStore();
    await store.putShell("same", shellEntry(), 300, 30);
    await store.setItem("same", "item-value", { ttl: 300 });
    await store.putResponse("same", new Response("resp"), 300);
    expect((await store.getShell("same"))?.entry.prelude).toBe(
      shellEntry().prelude,
    );
    expect((await store.getItem("same"))?.value).toBe("item-value");
    expect(await (await store.getResponse("same"))?.response.text()).toBe(
      "resp",
    );
  });

  it("clear() drops shell entries too", async () => {
    const store = new MemorySegmentCacheStore();
    await store.putShell("k", shellEntry(), 300, 30);
    await store.clear();
    expect(await store.getShell("k")).toBeNull();
  });
});
