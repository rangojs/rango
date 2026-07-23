import { describe, it, expect } from "vitest";
import { resolvePrefetchCacheTTL } from "../prefetch-cache-ttl.js";

// A5: createRouter({ prefetchCacheTTL: NaN | Infinity }) must NOT emit a
// malformed `Cache-Control: max-age=NaN` (CDNs/browsers reject it, silently
// disabling prefetch caching). Non-finite -> the 300s default. The existing
// false=disabled and negative=clamp-to-0 behavior is preserved.
describe("resolvePrefetchCacheTTL", () => {
  it("uses the 300s default when undefined", () => {
    expect(resolvePrefetchCacheTTL(undefined)).toEqual({
      seconds: 300,
      ms: 300_000,
      cacheControl: "private, max-age=300",
    });
  });

  it("disables caching when false", () => {
    expect(resolvePrefetchCacheTTL(false)).toEqual({
      seconds: 0,
      ms: 0,
      cacheControl: false,
    });
  });

  it("uses an explicit positive finite value", () => {
    expect(resolvePrefetchCacheTTL(60)).toEqual({
      seconds: 60,
      ms: 60_000,
      cacheControl: "private, max-age=60",
    });
  });

  it("floors fractional values", () => {
    expect(resolvePrefetchCacheTTL(60.9).seconds).toBe(60);
  });

  it("clamps negative finite values to 0 (disabled)", () => {
    expect(resolvePrefetchCacheTTL(-5)).toEqual({
      seconds: 0,
      ms: 0,
      cacheControl: false,
    });
  });

  it("falls back to the default for NaN (no max-age=NaN header)", () => {
    const r = resolvePrefetchCacheTTL(NaN);
    expect(r.seconds).toBe(300);
    expect(r.cacheControl).toBe("private, max-age=300");
    expect(String(r.cacheControl)).not.toContain("NaN");
  });

  it("falls back to the default for Infinity (no max-age=Infinity header)", () => {
    const r = resolvePrefetchCacheTTL(Infinity);
    expect(r.seconds).toBe(300);
    expect(r.cacheControl).toBe("private, max-age=300");
    expect(String(r.cacheControl)).not.toContain("Infinity");
  });
});
