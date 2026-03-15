import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { cancelAllPrefetchesMock, invalidateRangoStateMock } = vi.hoisted(
  () => ({
    cancelAllPrefetchesMock: vi.fn(),
    invalidateRangoStateMock: vi.fn(),
  }),
);

vi.mock("../browser/prefetch/queue", () => ({
  cancelAllPrefetches: cancelAllPrefetchesMock,
}));

vi.mock("../browser/rango-state", () => ({
  invalidateRangoState: invalidateRangoStateMock,
}));

import {
  buildPrefetchKey,
  clearPrefetchCache,
  clearPrefetchInflight,
  consumePrefetch,
  currentGeneration,
  hasPrefetch,
  markPrefetchInflight,
  storePrefetch,
} from "../browser/prefetch/cache";

describe("prefetch cache", () => {
  beforeEach(() => {
    clearPrefetchCache();
    cancelAllPrefetchesMock.mockClear();
    invalidateRangoStateMock.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("buildPrefetchKey includes source and target", () => {
    const target = new URL("http://localhost/products?page=1");
    expect(buildPrefetchKey("http://localhost/home", target)).toBe(
      "http://localhost/home\0/products?page=1",
    );
  });

  it("tracks inflight keys", () => {
    expect(hasPrefetch("/products")).toBe(false);

    markPrefetchInflight("/products");
    expect(hasPrefetch("/products")).toBe(true);

    clearPrefetchInflight("/products");
    expect(hasPrefetch("/products")).toBe(false);
  });

  it("tracks stored responses and reports them via hasPrefetch", () => {
    const key = "http://localhost/\0/products";
    expect(hasPrefetch(key)).toBe(false);

    const gen = currentGeneration();
    const response = new Response("test body");
    storePrefetch(key, response, gen);
    expect(hasPrefetch(key)).toBe(true);
  });

  it("consumePrefetch returns response and deletes entry", () => {
    const key = "http://localhost/\0/products";
    const gen = currentGeneration();
    const response = new Response("test body");
    storePrefetch(key, response, gen);

    const consumed = consumePrefetch(key);
    expect(consumed).toBe(response);
    expect(hasPrefetch(key)).toBe(false);

    // Second consume returns null
    expect(consumePrefetch(key)).toBe(null);
  });

  it("consumePrefetch returns null for expired entries", () => {
    const key = "http://localhost/\0/products";
    const gen = currentGeneration();
    const response = new Response("test body");
    storePrefetch(key, response, gen);

    // Fast-forward past TTL (30s)
    vi.useFakeTimers();
    vi.advanceTimersByTime(31_000);

    expect(consumePrefetch(key)).toBe(null);
    expect(hasPrefetch(key)).toBe(false);

    vi.useRealTimers();
  });

  it("ignores stale storage from older generation", () => {
    const staleGeneration = currentGeneration();

    clearPrefetchCache();
    storePrefetch(
      "http://localhost/\0/stale",
      new Response("body"),
      staleGeneration,
    );

    expect(hasPrefetch("http://localhost/\0/stale")).toBe(false);
    expect(consumePrefetch("http://localhost/\0/stale")).toBe(null);
  });

  it("clears state, bumps generation, and triggers invalidation side effects", () => {
    const before = currentGeneration();
    markPrefetchInflight("/a");
    storePrefetch("http://localhost/\0/b", new Response("body"), before);

    clearPrefetchCache();

    expect(currentGeneration()).toBe(before + 1);
    expect(hasPrefetch("/a")).toBe(false);
    expect(hasPrefetch("http://localhost/\0/b")).toBe(false);
    expect(cancelAllPrefetchesMock).toHaveBeenCalledTimes(1);
    expect(invalidateRangoStateMock).toHaveBeenCalledTimes(1);
  });

  it("evicts oldest entry when at max capacity", () => {
    const gen = currentGeneration();

    // Fill cache to capacity (50)
    for (let i = 0; i < 50; i++) {
      storePrefetch(`key-${i}`, new Response(`body-${i}`), gen);
    }

    // Adding one more should evict the oldest (key-0)
    storePrefetch("key-50", new Response("body-50"), gen);

    expect(hasPrefetch("key-0")).toBe(false);
    expect(hasPrefetch("key-50")).toBe(true);
    expect(hasPrefetch("key-1")).toBe(true);
  });
});
