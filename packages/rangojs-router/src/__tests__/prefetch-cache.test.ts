import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  abortAllPrefetchesMock,
  invalidateRangoStateMock,
  notifyPrefetchCacheInvalidatedMock,
} = vi.hoisted(() => ({
  abortAllPrefetchesMock: vi.fn(),
  invalidateRangoStateMock: vi.fn(),
  notifyPrefetchCacheInvalidatedMock: vi.fn(),
}));

vi.mock("../browser/prefetch/loader", () => ({
  abortAllPrefetches: abortAllPrefetchesMock,
}));

vi.mock("../browser/rango-state", () => ({
  invalidateRangoState: invalidateRangoStateMock,
}));

vi.mock("../browser/prefetch/invalidation", () => ({
  notifyPrefetchCacheInvalidated: notifyPrefetchCacheInvalidatedMock,
}));

import {
  buildPrefetchKey,
  buildSourceKey,
  clearPrefetchCache,
  clearPrefetchInflight,
  consumeInflightPrefetch,
  consumePrefetch,
  currentGeneration,
  hasPrefetch,
  initPrefetchCache,
  markPrefetchInflight,
  setInflightPromise,
  storePrefetch,
  type DecodedPrefetch,
} from "../browser/prefetch/cache";
import type { RscPayload } from "../browser/types";

/**
 * The cache stores eagerly-decoded prefetch entries (payload + streamComplete
 * + scope), not raw Responses. These helpers stand in for a real decode.
 */
function makeEntry(scope: "source" | "wildcard" = "wildcard"): DecodedPrefetch {
  return {
    payload: Promise.resolve({} as RscPayload),
    streamComplete: Promise.resolve(),
    scope,
    complete: false,
  };
}

describe("prefetch cache", () => {
  beforeEach(() => {
    clearPrefetchCache();
    abortAllPrefetchesMock.mockClear();
    invalidateRangoStateMock.mockClear();
    notifyPrefetchCacheInvalidatedMock.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("buildPrefetchKey concatenates prefix and target (wildcard shape)", () => {
    const target = new URL("http://localhost/products?page=1");
    expect(buildPrefetchKey("v1:123", target)).toBe("v1:123\0/products?page=1");
  });

  it("buildSourceKey embeds rango state and source href (source-scoped shape)", () => {
    const target = new URL("http://localhost/products?page=1");
    expect(buildSourceKey("v1:123", "http://localhost/home", target)).toBe(
      "v1:123\0http://localhost/home\0/products?page=1",
    );
  });

  it("tracks inflight keys", () => {
    expect(hasPrefetch("/products")).toBe(false);

    markPrefetchInflight("/products");
    expect(hasPrefetch("/products")).toBe(true);

    clearPrefetchInflight("/products");
    expect(hasPrefetch("/products")).toBe(false);
  });

  it("tracks stored entries and reports them via hasPrefetch", () => {
    const key = "http://localhost/\0/products";
    expect(hasPrefetch(key)).toBe(false);

    const gen = currentGeneration();
    storePrefetch(key, makeEntry(), gen);
    expect(hasPrefetch(key)).toBe(true);
  });

  it("consumePrefetch returns the decoded entry and deletes it", () => {
    const key = "http://localhost/\0/products";
    const gen = currentGeneration();
    const entry = makeEntry();
    storePrefetch(key, entry, gen);

    const consumed = consumePrefetch(key);
    expect(consumed).toBe(entry);
    expect(hasPrefetch(key)).toBe(false);

    // Second consume returns null
    expect(consumePrefetch(key)).toBe(null);
  });

  it("consumePrefetch returns null for expired entries", () => {
    const key = "http://localhost/\0/products";
    const gen = currentGeneration();
    storePrefetch(key, makeEntry(), gen);

    // Fast-forward past TTL (5 minutes)
    vi.useFakeTimers();
    vi.advanceTimersByTime(301_000);

    expect(consumePrefetch(key)).toBe(null);
    expect(hasPrefetch(key)).toBe(false);

    vi.useRealTimers();
  });

  it("ignores stale storage from older generation", () => {
    const staleGeneration = currentGeneration();

    clearPrefetchCache();
    storePrefetch("http://localhost/\0/stale", makeEntry(), staleGeneration);

    expect(hasPrefetch("http://localhost/\0/stale")).toBe(false);
    expect(consumePrefetch("http://localhost/\0/stale")).toBe(null);
  });

  it("clears state, bumps generation, and triggers invalidation side effects", () => {
    const before = currentGeneration();
    markPrefetchInflight("/a");
    storePrefetch("http://localhost/\0/b", makeEntry(), before);

    clearPrefetchCache();

    expect(currentGeneration()).toBe(before + 1);
    expect(hasPrefetch("/a")).toBe(false);
    expect(hasPrefetch("http://localhost/\0/b")).toBe(false);
    expect(abortAllPrefetchesMock).toHaveBeenCalledTimes(1);
    expect(invalidateRangoStateMock).toHaveBeenCalledTimes(1);
    expect(notifyPrefetchCacheInvalidatedMock).toHaveBeenCalledTimes(1);
  });

  it("can clear a receiving tab without rotating shared rango state", () => {
    clearPrefetchCache(false);

    expect(abortAllPrefetchesMock).toHaveBeenCalledOnce();
    expect(invalidateRangoStateMock).not.toHaveBeenCalled();
    expect(notifyPrefetchCacheInvalidatedMock).toHaveBeenCalledOnce();
  });

  it("evicts oldest entry at the default max capacity (100)", () => {
    const gen = currentGeneration();

    // Fill cache to the DEFAULT capacity (100) — no initPrefetchCache call, so
    // this also pins the module default (configurable size is covered below).
    for (let i = 0; i < 100; i++) {
      storePrefetch(`key-${i}`, makeEntry(), gen);
    }

    // Adding one more should evict the oldest (key-0)
    storePrefetch("key-100", makeEntry(), gen);

    expect(hasPrefetch("key-0")).toBe(false);
    expect(hasPrefetch("key-100")).toBe(true);
    expect(hasPrefetch("key-1")).toBe(true);
  });

  it("preserves the scope tag through store/consume", () => {
    const gen = currentGeneration();
    storePrefetch("http://localhost/\0/modal", makeEntry("source"), gen);
    expect(consumePrefetch("http://localhost/\0/modal")?.scope).toBe("source");
  });

  describe("inflight promise tracking", () => {
    it("consumeInflightPrefetch returns stored promise and removes it", async () => {
      const key = "http://localhost/\0/products";
      const entry = makeEntry();
      const promise = Promise.resolve(entry);

      markPrefetchInflight(key);
      setInflightPromise(key, promise);

      expect(hasPrefetch(key)).toBe(true);

      const consumed = consumeInflightPrefetch(key);
      expect(consumed).toBe(promise);
      // Inflight flag is preserved so hasPrefetch() blocks duplicates
      expect(hasPrefetch(key)).toBe(true);
      // Second consume returns null (promise already handed off)
      expect(consumeInflightPrefetch(key)).toBe(null);
      // clearPrefetchInflight removes the inflight flag
      clearPrefetchInflight(key);
      expect(hasPrefetch(key)).toBe(false);

      // Promise still resolves correctly
      const result = await consumed;
      expect(result).toBe(entry);
    });

    it("consumeInflightPrefetch returns null when nothing is in-flight", () => {
      expect(consumeInflightPrefetch("nonexistent")).toBe(null);
    });

    it("clearPrefetchInflight removes both inflight flag and promise", () => {
      const key = "/test";
      markPrefetchInflight(key);
      setInflightPromise(key, Promise.resolve(null));

      expect(hasPrefetch(key)).toBe(true);

      clearPrefetchInflight(key);
      expect(hasPrefetch(key)).toBe(false);
      expect(consumeInflightPrefetch(key)).toBe(null);
    });

    it("clearPrefetchCache clears inflight promises", () => {
      const key = "/test";
      markPrefetchInflight(key);
      setInflightPromise(key, Promise.resolve(makeEntry()));

      clearPrefetchCache();

      expect(consumeInflightPrefetch(key)).toBe(null);
    });
  });

  describe("configurable max size (FIFO eviction)", () => {
    afterEach(() => {
      // clearPrefetchCache (beforeEach) clears stored entries but NOT config,
      // so restore the module default size for any later test in this file.
      initPrefetchCache(300_000, 100);
    });

    it("evicts the oldest entry once the configured size is reached", () => {
      // Drive eviction at a small, explicit capacity rather than the default 100.
      initPrefetchCache(300_000, 3);
      const gen = currentGeneration();
      const keys = ["k1", "k2", "k3", "k4"].map((k) => `s\0/${k}`);
      for (const key of keys) storePrefetch(key, makeEntry(), gen);

      // Capacity 3: storing the 4th evicts the oldest (k1); newest 3 remain.
      expect(hasPrefetch(keys[0])).toBe(false);
      expect(hasPrefetch(keys[1])).toBe(true);
      expect(hasPrefetch(keys[2])).toBe(true);
      expect(hasPrefetch(keys[3])).toBe(true);
    });

    it("ignores a sub-1 size and keeps the previous capacity", () => {
      initPrefetchCache(300_000, 3);
      initPrefetchCache(300_000, 0); // ignored: size stays 3, not 0
      const gen = currentGeneration();
      const keys = ["a", "b", "c", "d"].map((k) => `s\0/${k}`);
      for (const key of keys) storePrefetch(key, makeEntry(), gen);

      // Capacity stayed 3 (the 0 was ignored): a evicted, newest 3 remain.
      // b and c surviving is the discriminator — a buggy size 0 evicts-then-sets
      // on every store, leaving only d.
      expect(hasPrefetch(keys[0])).toBe(false);
      expect(hasPrefetch(keys[1])).toBe(true);
      expect(hasPrefetch(keys[2])).toBe(true);
      expect(hasPrefetch(keys[3])).toBe(true);
    });
  });
});
