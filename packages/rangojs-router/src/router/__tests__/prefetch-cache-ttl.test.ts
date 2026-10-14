import { describe, it, expect } from "vitest";
import { resolvePrefetchCacheTTL } from "../prefetch-cache-ttl.js";

// A5: createRouter({ prefetchCacheTTL: NaN | Infinity }) falls back to the
// 300s default instead of disabling the in-memory prefetch cache. The
// false=disabled and negative=clamp-to-0 behavior is preserved.
describe("resolvePrefetchCacheTTL", () => {
  it("uses the 300s default when undefined", () => {
    expect(resolvePrefetchCacheTTL(undefined)).toEqual({
      seconds: 300,
      ms: 300_000,
    });
  });

  it("disables caching when false", () => {
    expect(resolvePrefetchCacheTTL(false)).toEqual({ seconds: 0, ms: 0 });
  });

  it("uses an explicit positive finite value", () => {
    expect(resolvePrefetchCacheTTL(60)).toEqual({ seconds: 60, ms: 60_000 });
  });

  it("floors fractional values", () => {
    expect(resolvePrefetchCacheTTL(60.9).seconds).toBe(60);
  });

  it("clamps negative finite values to 0 (disabled)", () => {
    expect(resolvePrefetchCacheTTL(-5)).toEqual({ seconds: 0, ms: 0 });
  });

  it("falls back to the default for NaN", () => {
    expect(resolvePrefetchCacheTTL(NaN)).toEqual({ seconds: 300, ms: 300_000 });
  });

  it("falls back to the default for Infinity", () => {
    expect(resolvePrefetchCacheTTL(Infinity)).toEqual({
      seconds: 300,
      ms: 300_000,
    });
  });
});
