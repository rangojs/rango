import { describe, it, expect } from "vitest";
import {
  DEFAULT_PREFETCH_CACHE_SIZE,
  DEFAULT_PREFETCH_CONCURRENCY,
  resolvePrefetchCacheSize,
  resolvePrefetchConcurrency,
} from "../prefetch-limits.js";

// Counts, not durations: unlike prefetchCacheTTL (where false/0 intentionally
// disables prefetching), a cache size or concurrency below 1 would silently
// break prefetching while leaving it nominally on. So sub-1/non-finite inputs
// fall back to the default; finite values >= 1 are floored.
describe("resolvePrefetchCacheSize", () => {
  it("defaults to 100 when undefined", () => {
    expect(DEFAULT_PREFETCH_CACHE_SIZE).toBe(100);
    expect(resolvePrefetchCacheSize(undefined)).toBe(100);
  });

  it("uses an explicit positive finite value", () => {
    expect(resolvePrefetchCacheSize(250)).toBe(250);
  });

  it("floors fractional values >= 1", () => {
    expect(resolvePrefetchCacheSize(100.9)).toBe(100);
  });

  it("falls back to the default for 0, negative, and sub-1 values", () => {
    expect(resolvePrefetchCacheSize(0)).toBe(100);
    expect(resolvePrefetchCacheSize(-5)).toBe(100);
    expect(resolvePrefetchCacheSize(0.5)).toBe(100);
  });

  it("falls back to the default for NaN and Infinity", () => {
    expect(resolvePrefetchCacheSize(NaN)).toBe(100);
    expect(resolvePrefetchCacheSize(Infinity)).toBe(100);
  });
});

describe("resolvePrefetchConcurrency", () => {
  it("defaults to 2 when undefined", () => {
    expect(DEFAULT_PREFETCH_CONCURRENCY).toBe(2);
    expect(resolvePrefetchConcurrency(undefined)).toBe(2);
  });

  it("uses an explicit positive finite value", () => {
    expect(resolvePrefetchConcurrency(6)).toBe(6);
  });

  it("floors fractional values >= 1", () => {
    expect(resolvePrefetchConcurrency(3.9)).toBe(3);
  });

  it("falls back to the default for 0, negative, and sub-1 values", () => {
    expect(resolvePrefetchConcurrency(0)).toBe(2);
    expect(resolvePrefetchConcurrency(-1)).toBe(2);
    expect(resolvePrefetchConcurrency(0.9)).toBe(2);
  });

  it("falls back to the default for NaN and Infinity", () => {
    expect(resolvePrefetchConcurrency(NaN)).toBe(2);
    expect(resolvePrefetchConcurrency(Infinity)).toBe(2);
  });
});
