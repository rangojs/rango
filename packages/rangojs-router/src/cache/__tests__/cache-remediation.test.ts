import { describe, it, expect, vi, beforeEach } from "vitest";
import type { HandleStore } from "../../server/handle-store.js";

// ============================================================================
// 1. Profile validation and grammar (exercises production code)
// ============================================================================

describe("cache profile validation", () => {
  let setCacheProfiles: typeof import("../profile-registry.js").setCacheProfiles;
  let getCacheProfile: typeof import("../profile-registry.js").getCacheProfile;
  let resolveCacheProfiles: typeof import("../profile-registry.js").resolveCacheProfiles;

  beforeEach(async () => {
    const mod = await import("../profile-registry.js");
    setCacheProfiles = mod.setCacheProfiles;
    getCacheProfile = mod.getCacheProfile;
    resolveCacheProfiles = mod.resolveCacheProfiles;
  });

  it("accepts names with letters, digits, hyphens, and underscores", () => {
    expect(() =>
      setCacheProfiles({
        default: { ttl: 60 },
        short: { ttl: 10 },
        "long-lived": { ttl: 3600 },
        with_underscore: { ttl: 300 },
        "mix-ed_123": { ttl: 120 },
      }),
    ).not.toThrow();
  });

  it("rejects names with spaces", () => {
    expect(() =>
      setCacheProfiles({
        default: { ttl: 60 },
        "bad name": { ttl: 10 },
      }),
    ).toThrow(/Invalid cache profile name/);
  });

  it("rejects names with special characters", () => {
    expect(() =>
      setCacheProfiles({
        default: { ttl: 60 },
        "bad.name": { ttl: 10 },
      }),
    ).toThrow(/Invalid cache profile name/);
  });

  it("rejects empty string name", () => {
    expect(() =>
      setCacheProfiles({
        default: { ttl: 60 },
        "": { ttl: 10 },
      }),
    ).toThrow(/Invalid cache profile name/);
  });

  it("always ensures a default profile exists", () => {
    setCacheProfiles({ short: { ttl: 10 } });
    const defaultProfile = getCacheProfile("default");
    expect(defaultProfile).toBeDefined();
    expect(defaultProfile!.ttl).toBe(900);
  });

  it("preserves user-defined default profile", () => {
    setCacheProfiles({ default: { ttl: 42 } });
    const defaultProfile = getCacheProfile("default");
    expect(defaultProfile!.ttl).toBe(42);
  });

  describe("resolveCacheProfiles", () => {
    it("returns default profile when called with undefined", () => {
      const resolved = resolveCacheProfiles(undefined);
      expect(resolved.default).toBeDefined();
      expect(resolved.default.ttl).toBe(900);
    });

    it("merges user profiles with default", () => {
      const resolved = resolveCacheProfiles({ short: { ttl: 10 } });
      expect(resolved.default).toBeDefined();
      expect(resolved.short.ttl).toBe(10);
    });

    it("allows overriding default profile", () => {
      const resolved = resolveCacheProfiles({ default: { ttl: 42 } });
      expect(resolved.default.ttl).toBe(42);
    });

    it("validates profile names", () => {
      expect(() => resolveCacheProfiles({ "bad.name": { ttl: 10 } })).toThrow(
        /Invalid cache profile name/,
      );
    });
  });
});

// ============================================================================
// 2. Multi-router profile isolation
// ============================================================================

describe("multi-router profile isolation", () => {
  let setCacheProfiles: typeof import("../profile-registry.js").setCacheProfiles;
  let getCacheProfile: typeof import("../profile-registry.js").getCacheProfile;

  beforeEach(async () => {
    const mod = await import("../profile-registry.js");
    setCacheProfiles = mod.setCacheProfiles;
    getCacheProfile = mod.getCacheProfile;
  });

  it("setCacheProfiles replaces previous profiles entirely", () => {
    setCacheProfiles({
      default: { ttl: 60 },
      routerA: { ttl: 100 },
    });
    expect(getCacheProfile("routerA")).toBeDefined();

    // Second router replaces profiles
    setCacheProfiles({
      default: { ttl: 30 },
      routerB: { ttl: 200 },
    });

    expect(getCacheProfile("routerB")).toBeDefined();
    expect(getCacheProfile("routerA")).toBeUndefined();
  });
});

// ============================================================================
// 3. Directive grammar regex (from use-cache-transform)
// ============================================================================

describe("use-cache directive grammar", () => {
  // The regex used by the Vite transform for function-level directives.
  // Must stay in sync with use-cache-transform.ts.
  const directiveRegex = /^use cache(:\s*[\w-]+)?$/;

  it("matches plain 'use cache'", () => {
    expect(directiveRegex.test("use cache")).toBe(true);
  });

  it("matches 'use cache: short'", () => {
    expect(directiveRegex.test("use cache: short")).toBe(true);
  });

  it("matches profile names with hyphens", () => {
    expect(directiveRegex.test("use cache: long-lived")).toBe(true);
  });

  it("matches profile names with underscores", () => {
    expect(directiveRegex.test("use cache: with_underscore")).toBe(true);
  });

  it("matches profile names with digits", () => {
    expect(directiveRegex.test("use cache: cache123")).toBe(true);
  });

  it("matches mixed names", () => {
    expect(directiveRegex.test("use cache: mix-ed_123")).toBe(true);
  });

  it("rejects names with dots", () => {
    expect(directiveRegex.test("use cache: bad.name")).toBe(false);
  });

  it("rejects names with spaces", () => {
    expect(directiveRegex.test("use cache: bad name")).toBe(false);
  });

  it("rejects unrelated directives", () => {
    expect(directiveRegex.test("use server")).toBe(false);
    expect(directiveRegex.test("use client")).toBe(false);
  });
});

// ============================================================================
// 4. Handle capture concurrency (exercises production startHandleCapture)
// ============================================================================

// Import the production startHandleCapture indirectly by importing the
// cache-runtime module. Since startHandleCapture is not exported, we test
// through the public interface: create a real HandleStore, run captures
// via the internal mechanism (activeCapturesMap + interceptor).
//
// The key behavior to verify: overlapping captures that finish out of
// order do not corrupt the push chain.

describe("handle capture concurrency", () => {
  let createHandleStore: typeof import("../../server/handle-store.js").createHandleStore;
  let startHandleCapture: typeof import("../handle-capture.js").startHandleCapture;

  beforeEach(async () => {
    const storeModule = await import("../../server/handle-store.js");
    createHandleStore = storeModule.createHandleStore;
    const captureModule = await import("../handle-capture.js");
    startHandleCapture = captureModule.startHandleCapture;
  });

  it("push still works on a real HandleStore after any capture lifecycle", () => {
    const store = createHandleStore();

    // Push should work before any capture
    expect(() => store.push("handle1", "seg1", "value1")).not.toThrow();

    // Verify data was stored
    const data = store.getDataForSegment("seg1");
    expect(data["handle1"]).toEqual(["value1"]);
  });

  it("concurrent captures are order-independent (production startHandleCapture)", () => {
    const store = createHandleStore();

    // Start capture A using production startHandleCapture
    const captureA = startHandleCapture(store);
    store.push("breadcrumbs", "seg1", "A-1");

    // Start capture B (overlapping)
    const captureB = startHandleCapture(store);
    store.push("meta", "seg2", "B-1");

    // Stop A FIRST (out of order — A started first but stops first)
    captureA.stop();
    store.push("title", "seg3", "B-2");

    // Stop B
    captureB.stop();
    store.push("breadcrumbs", "seg1", "after-both");

    // A captured: its own push + B's first push (both were active)
    expect(captureA.capture.data["seg1"]?.["breadcrumbs"]).toEqual(["A-1"]);
    expect(captureA.capture.data["seg2"]?.["meta"]).toEqual(["B-1"]);
    expect(captureA.capture.data["seg3"]).toBeUndefined();

    // B captured: B's pushes + the overlap with A
    expect(captureB.capture.data["seg2"]?.["meta"]).toEqual(["B-1"]);
    expect(captureB.capture.data["seg3"]?.["title"]).toEqual(["B-2"]);
    expect(captureB.capture.data["seg1"]?.["breadcrumbs"]).toBeUndefined();

    // Original store received everything
    const seg1Data = store.getDataForSegment("seg1");
    expect(seg1Data["breadcrumbs"]).toEqual(["A-1", "after-both"]);
    const seg2Data = store.getDataForSegment("seg2");
    expect(seg2Data["meta"]).toEqual(["B-1"]);
    const seg3Data = store.getDataForSegment("seg3");
    expect(seg3Data["title"]).toEqual(["B-2"]);
  });
});

// ============================================================================
// 5. sortedSearchString (cache key correctness)
// ============================================================================

// Mock request-context to test CacheScope key generation (which uses
// the production sortedSearchString internally).
const mockGetRequestContext = vi.fn<() => any>(() => null);
const mock_getRequestContext = vi.fn<() => any>(() => null);

vi.mock("../../server/request-context.js", () => ({
  getRequestContext: () => mockGetRequestContext(),
  _getRequestContext: () => mock_getRequestContext(),
}));

vi.mock("../../internal-debug.js", () => ({
  INTERNAL_RANGO_DEBUG: false,
}));

vi.mock("../segment-codec.js", () => ({
  serializeSegments: vi.fn(),
  deserializeSegments: vi.fn(),
}));

vi.mock("../handle-snapshot.js", () => ({
  captureHandles: vi.fn(),
  restoreHandles: vi.fn(),
}));

describe("cache key search param handling (via CacheScope)", () => {
  let CacheScope: typeof import("../cache-scope.js").CacheScope;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockGetRequestContext.mockReturnValue(null);
    mock_getRequestContext.mockReturnValue(null);
    const mod = await import("../cache-scope.js");
    CacheScope = mod.CacheScope;
  });

  function makeRequestContext(searchString: string) {
    const url = new URL(`http://localhost/test${searchString}`);
    return { url, _cacheStore: null, _handleStore: null };
  }

  it("produces distinct keys for different query params", async () => {
    const store = { get: vi.fn().mockResolvedValue(null), set: vi.fn() };

    mockGetRequestContext.mockReturnValue(
      makeRequestContext("?page=1&sort=asc"),
    );
    const scope1 = new CacheScope({ store } as any);
    await scope1.lookupRoute("/products", {});
    const key1 = store.get.mock.calls[0][0];

    store.get.mockClear();
    mockGetRequestContext.mockReturnValue(
      makeRequestContext("?page=2&sort=asc"),
    );
    const scope2 = new CacheScope({ store } as any);
    await scope2.lookupRoute("/products", {});
    const key2 = store.get.mock.calls[0][0];

    expect(key1).not.toBe(key2);
  });

  it("excludes _rsc* and __* params from key", async () => {
    const store = { get: vi.fn().mockResolvedValue(null), set: vi.fn() };

    mockGetRequestContext.mockReturnValue(
      makeRequestContext("?page=1&_rsc_partial=1&__debug=true"),
    );
    const scope = new CacheScope({ store } as any);
    await scope.lookupRoute("/test", {});
    const key = store.get.mock.calls[0][0] as string;

    expect(key).toContain("page=1");
    expect(key).not.toContain("_rsc");
    expect(key).not.toContain("__debug");
  });

  it("sorts params deterministically", async () => {
    const store = { get: vi.fn().mockResolvedValue(null), set: vi.fn() };

    mockGetRequestContext.mockReturnValue(makeRequestContext("?z=1&a=2&m=3"));
    const scope1 = new CacheScope({ store } as any);
    await scope1.lookupRoute("/test", {});
    const key1 = store.get.mock.calls[0][0];

    store.get.mockClear();
    mockGetRequestContext.mockReturnValue(makeRequestContext("?m=3&z=1&a=2"));
    const scope2 = new CacheScope({ store } as any);
    await scope2.lookupRoute("/test", {});
    const key2 = store.get.mock.calls[0][0];

    expect(key1).toBe(key2);
  });
});

// ============================================================================
// 6. Route cache condition enforcement
// ============================================================================

describe("route cache condition enforcement", () => {
  let CacheScope: typeof import("../cache-scope.js").CacheScope;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import("../cache-scope.js");
    CacheScope = mod.CacheScope;
  });

  function makeRequestContext(searchString: string) {
    const url = new URL(`http://localhost/test${searchString}`);
    return {
      url,
      _cacheStore: null,
      _handleStore: null,
      request: new Request(url),
    };
  }

  it("skips cache read when condition returns false", async () => {
    const store = { get: vi.fn().mockResolvedValue(null), set: vi.fn() };

    mockGetRequestContext.mockReturnValue(makeRequestContext(""));
    const scope = new CacheScope({ store, condition: () => false } as any);
    const result = await scope.lookupRoute("/test", {});

    expect(result).toBeNull();
    // store.get should never have been called
    expect(store.get).not.toHaveBeenCalled();
  });

  it("proceeds with cache read when condition returns true", async () => {
    const store = { get: vi.fn().mockResolvedValue(null), set: vi.fn() };

    mockGetRequestContext.mockReturnValue(makeRequestContext(""));
    const scope = new CacheScope({ store, condition: () => true } as any);
    await scope.lookupRoute("/test", {});

    expect(store.get).toHaveBeenCalled();
  });

  it("skips cache write when condition returns false", async () => {
    const store = { get: vi.fn(), set: vi.fn() };
    const ctx = makeRequestContext("");
    (ctx as any).waitUntil = (fn: () => Promise<void>) => fn();

    mockGetRequestContext.mockReturnValue(ctx);
    mock_getRequestContext.mockReturnValue({
      ...ctx,
      _handleStore: {
        settled: Promise.resolve(),
        getDataForSegment: () => ({}),
      },
    });

    const scope = new CacheScope({ store, condition: () => false } as any);
    await scope.cacheRoute("/test", {}, [
      { type: "route", id: "R0", component: "<div/>" } as any,
    ]);

    expect(store.set).not.toHaveBeenCalled();
  });

  it("fails open when condition throws", async () => {
    const store = { get: vi.fn().mockResolvedValue(null), set: vi.fn() };

    mockGetRequestContext.mockReturnValue(makeRequestContext(""));
    const scope = new CacheScope({
      store,
      condition: () => {
        throw new Error("boom");
      },
    } as any);
    const result = await scope.lookupRoute("/test", {});

    // Should skip cache (fail open), not throw
    expect(result).toBeNull();
    expect(store.get).not.toHaveBeenCalled();
  });
});
