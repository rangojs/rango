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
  clearPrefetchCache,
  clearPrefetchInflight,
  currentGeneration,
  hasPrefetch,
  markPrefetchInflight,
  markPrefetched,
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

  it("tracks inflight and prefetched keys", () => {
    expect(hasPrefetch("/products")).toBe(false);

    markPrefetchInflight("/products");
    expect(hasPrefetch("/products")).toBe(true);

    clearPrefetchInflight("/products");
    expect(hasPrefetch("/products")).toBe(false);

    const gen = currentGeneration();
    markPrefetched("/products", gen);
    expect(hasPrefetch("/products")).toBe(true);
  });

  it("ignores stale completions from older generation", () => {
    const staleGeneration = currentGeneration();

    clearPrefetchCache();
    markPrefetched("/stale", staleGeneration);

    expect(hasPrefetch("/stale")).toBe(false);
  });

  it("clears state, bumps generation, and triggers invalidation side effects", () => {
    const before = currentGeneration();
    markPrefetchInflight("/a");
    markPrefetched("/b", before);

    clearPrefetchCache();

    expect(currentGeneration()).toBe(before + 1);
    expect(hasPrefetch("/a")).toBe(false);
    expect(hasPrefetch("/b")).toBe(false);
    expect(cancelAllPrefetchesMock).toHaveBeenCalledTimes(1);
    expect(invalidateRangoStateMock).toHaveBeenCalledTimes(1);
  });
});
