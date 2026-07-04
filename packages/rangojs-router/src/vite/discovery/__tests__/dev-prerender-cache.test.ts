import { describe, it, expect } from "vitest";
import {
  createDevPrerenderCache,
  devPrerenderCacheKey,
  payloadBodiesFromResult,
  type DevPrerenderMatchPayloadSource,
} from "../dev-prerender-cache";
import type { SerializedSegmentData } from "../../../cache/types";

const seg = (id: string): SerializedSegmentData =>
  ({
    id,
    namespace: "route",
    encoded: `<${id}>`,
  }) as unknown as SerializedSegmentData;

const baseResult = (
  overrides: Partial<DevPrerenderMatchPayloadSource> = {},
): DevPrerenderMatchPayloadSource => ({
  segments: [seg("a"), seg("b")],
  handles: "H",
  ...overrides,
});

describe("devPrerenderCacheKey", () => {
  it("distinguishes every request dimension", () => {
    const dims = { intercept: false, passthrough: false, routeName: null };
    const base = devPrerenderCacheKey("/docs", dims);
    expect(
      devPrerenderCacheKey("/docs", { ...dims, intercept: true }),
    ).not.toBe(base);
    expect(
      devPrerenderCacheKey("/docs", { ...dims, passthrough: true }),
    ).not.toBe(base);
    expect(
      devPrerenderCacheKey("/docs", { ...dims, routeName: "docs" }),
    ).not.toBe(base);
    expect(devPrerenderCacheKey("/other", dims)).not.toBe(base);
  });

  it("treats null and absent routeName identically", () => {
    const a = devPrerenderCacheKey("/x", {
      intercept: false,
      passthrough: false,
      routeName: null,
    });
    const b = devPrerenderCacheKey("/x", {
      intercept: false,
      passthrough: false,
      routeName: "",
    });
    // "" and null both mean "no routeName filter" at the endpoint
    // (searchParams.get returns null; the filter only applies when truthy).
    expect(a).toBe(b);
  });
});

describe("payloadBodiesFromResult", () => {
  it("main body carries the route's own segments and handles", () => {
    const bodies = payloadBodiesFromResult(baseResult());
    expect(JSON.parse(bodies.main)).toEqual({
      segments: [seg("a"), seg("b")],
      handles: "H",
    });
  });

  it("intercept body merges intercept segments and uses the MERGED handles", () => {
    const bodies = payloadBodiesFromResult(
      baseResult({
        interceptSegments: [seg("modal")],
        interceptHandles: "MERGED",
      }),
    );
    expect(JSON.parse(bodies.intercept)).toEqual({
      segments: [seg("a"), seg("b"), seg("modal")],
      handles: "MERGED",
    });
  });

  it("intercept body falls back to empty handles when interceptHandles is absent", () => {
    const bodies = payloadBodiesFromResult(
      baseResult({ interceptSegments: [seg("modal")] }),
    );
    expect(JSON.parse(bodies.intercept).handles).toBe("");
  });

  it("intercept body is byte-identical to main when the route has no intercepts", () => {
    // Mirrors the endpoint's historical behavior: intercept=1 for a route
    // without intercept segments serves the main payload.
    expect(payloadBodiesFromResult(baseResult()).intercept).toBe(
      payloadBodiesFromResult(baseResult()).main,
    );
    const empty = payloadBodiesFromResult(
      baseResult({ interceptSegments: [] }),
    );
    expect(empty.intercept).toBe(empty.main);
  });
});

describe("createDevPrerenderCache", () => {
  it("hits for the same router instance and key, misses across keys", () => {
    const cache = createDevPrerenderCache();
    const router = {};
    cache.set(router, "k1", "body1");
    expect(cache.get(router, "k1")).toBe("body1");
    expect(cache.get(router, "k2")).toBeUndefined();
  });

  it("misses for a different router instance — identity IS the HMR generation", () => {
    const cache = createDevPrerenderCache();
    const oldGeneration = {};
    const newGeneration = {};
    cache.set(oldGeneration, "k", "stale");
    // After an HMR-invalidated chain re-evaluates, createRouter() registers
    // a NEW instance; the cache must not serve the old generation's body.
    expect(cache.get(newGeneration, "k")).toBeUndefined();
    // The old bucket stays intact (WeakMap; GC reclaims it when the
    // registry drops the instance) but is only reachable via old identity.
    expect(cache.get(oldGeneration, "k")).toBe("stale");
  });

  it("overwrites an existing key in place", () => {
    const cache = createDevPrerenderCache();
    const router = {};
    cache.set(router, "k", "v1");
    cache.set(router, "k", "v2");
    expect(cache.get(router, "k")).toBe("v2");
  });

  it("caps each router bucket FIFO at the configured size", () => {
    const cache = createDevPrerenderCache(2);
    const router = {};
    cache.set(router, "k1", "v1");
    cache.set(router, "k2", "v2");
    cache.set(router, "k3", "v3"); // evicts k1 (oldest)
    expect(cache.get(router, "k1")).toBeUndefined();
    expect(cache.get(router, "k2")).toBe("v2");
    expect(cache.get(router, "k3")).toBe("v3");
  });

  it("does not evict when overwriting an existing key at capacity", () => {
    const cache = createDevPrerenderCache(2);
    const router = {};
    cache.set(router, "k1", "v1");
    cache.set(router, "k2", "v2");
    cache.set(router, "k1", "v1b"); // overwrite, not insert — no eviction
    expect(cache.get(router, "k1")).toBe("v1b");
    expect(cache.get(router, "k2")).toBe("v2");
  });

  it("caps per router, not globally", () => {
    const cache = createDevPrerenderCache(1);
    const a = {};
    const b = {};
    cache.set(a, "k", "va");
    cache.set(b, "k", "vb");
    expect(cache.get(a, "k")).toBe("va");
    expect(cache.get(b, "k")).toBe("vb");
  });
});
