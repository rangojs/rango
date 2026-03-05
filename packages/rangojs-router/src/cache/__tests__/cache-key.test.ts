import { describe, it, expect, vi, beforeEach } from "vitest";

// We need to test sortedSearchString and getCacheKeyBase which are internal
// (not exported). We test them indirectly via getDefaultRouteCacheKey which is
// also internal but used by CacheScope. Instead, we import the module and test
// the observable behavior through CacheScope or replicate the logic inline.
//
// Since these are unexported functions, we test the combined behavior by
// reimporting the module internals. Vitest can access private functions through
// the module system when we use dynamic import.

// Mock request-context to control getRequestContext return value
const mockGetRequestContext = vi.fn<() => any>(() => null);
const mock_getRequestContext = vi.fn<() => any>(() => null);

vi.mock("../../server/request-context.js", () => ({
  getRequestContext: () => mockGetRequestContext(),
  _getRequestContext: () => mock_getRequestContext(),
}));

// Mock internal-debug
vi.mock("../../internal-debug.js", () => ({
  INTERNAL_RANGO_DEBUG: false,
}));

// Mock segment-codec and handle-snapshot (not needed for key tests)
vi.mock("../segment-codec.js", () => ({
  serializeSegments: vi.fn(),
  deserializeSegments: vi.fn(),
}));

vi.mock("../handle-snapshot.js", () => ({
  captureHandles: vi.fn(),
  restoreHandles: vi.fn(),
}));

const { CacheScope } = await import("../cache-scope.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequestContext(searchString: string) {
  const url = new URL(`http://localhost/test${searchString}`);
  return {
    url,
    _cacheStore: null,
    _handleStore: null,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("segment cache key generation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetRequestContext.mockReturnValue(null);
    mock_getRequestContext.mockReturnValue(null);
  });

  describe("searchParams scoping", () => {
    it("should include user-facing search params in cache key", async () => {
      const store = {
        get: vi.fn().mockResolvedValue(null),
        set: vi.fn(),
      };

      // Two requests with different query params
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
      expect(key1).toContain("page=1");
      expect(key2).toContain("page=2");
    });

    it("should sort search params alphabetically for deterministic keys", async () => {
      const store = {
        get: vi.fn().mockResolvedValue(null),
        set: vi.fn(),
      };

      // Same params in different order
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
      // Verify sorted order: a before m before z
      expect(key1).toMatch(/a=2.*m=3.*z=1/);
    });
  });

  describe("_rsc and __ param exclusion", () => {
    it("should exclude _rsc* params from cache key", async () => {
      const store = {
        get: vi.fn().mockResolvedValue(null),
        set: vi.fn(),
      };

      mockGetRequestContext.mockReturnValue(
        makeRequestContext(
          "?page=1&_rsc_partial=1&_rsc_segments=M0L0&_rsc_stale=true",
        ),
      );
      const scope = new CacheScope({ store } as any);
      await scope.lookupRoute("/test", {});
      const key = store.get.mock.calls[0][0];

      expect(key).toContain("page=1");
      expect(key).not.toContain("_rsc");
    });

    it("should exclude __ prefixed params from cache key", async () => {
      const store = {
        get: vi.fn().mockResolvedValue(null),
        set: vi.fn(),
      };

      mockGetRequestContext.mockReturnValue(
        makeRequestContext("?page=1&__debug=true&__trace=abc"),
      );
      const scope = new CacheScope({ store } as any);
      await scope.lookupRoute("/test", {});
      const key = store.get.mock.calls[0][0];

      expect(key).toContain("page=1");
      expect(key).not.toContain("__debug");
      expect(key).not.toContain("__trace");
    });

    it("should produce same query component with and without internal params", async () => {
      const store = {
        get: vi.fn().mockResolvedValue(null),
        set: vi.fn(),
      };

      // With internal params — note: _rsc_partial changes the prefix to "partial"
      // so we compare only the query portion after the prefix.
      mockGetRequestContext.mockReturnValue(
        makeRequestContext("?page=1&_rsc_partial=1"),
      );
      const scope1 = new CacheScope({ store } as any);
      await scope1.lookupRoute("/test", {});
      const key1 = store.get.mock.calls[0][0] as string;

      // Without internal params
      store.get.mockClear();
      mockGetRequestContext.mockReturnValue(makeRequestContext("?page=1"));
      const scope2 = new CacheScope({ store } as any);
      await scope2.lookupRoute("/test", {});
      const key2 = store.get.mock.calls[0][0] as string;

      // Strip the prefix (doc: or partial:) to compare the path+query portion
      const stripPrefix = (k: string) =>
        k.replace(/^(doc|partial|intercept):/, "");
      expect(stripPrefix(key1)).toBe(stripPrefix(key2));
    });
  });

  describe("request type prefix", () => {
    it("should use 'doc' prefix for document requests", async () => {
      const store = {
        get: vi.fn().mockResolvedValue(null),
        set: vi.fn(),
      };

      mockGetRequestContext.mockReturnValue(makeRequestContext(""));
      const scope = new CacheScope({ store } as any);
      await scope.lookupRoute("/test", {});
      const key = store.get.mock.calls[0][0];

      expect(key).toMatch(/^doc:/);
    });

    it("should use 'partial' prefix for partial (navigation) requests", async () => {
      const store = {
        get: vi.fn().mockResolvedValue(null),
        set: vi.fn(),
      };

      mockGetRequestContext.mockReturnValue(
        makeRequestContext("?_rsc_partial=1"),
      );
      const scope = new CacheScope({ store } as any);
      await scope.lookupRoute("/test", {});
      const key = store.get.mock.calls[0][0];

      expect(key).toMatch(/^partial:/);
    });

    it("should use 'intercept' prefix for intercept requests", async () => {
      const store = {
        get: vi.fn().mockResolvedValue(null),
        set: vi.fn(),
      };

      mockGetRequestContext.mockReturnValue(makeRequestContext(""));
      const scope = new CacheScope({ store } as any);
      await scope.lookupRoute("/test", {}, true);
      const key = store.get.mock.calls[0][0];

      expect(key).toMatch(/^intercept:/);
    });
  });

  describe("route params in key", () => {
    it("should include sorted route params in cache key", async () => {
      const store = {
        get: vi.fn().mockResolvedValue(null),
        set: vi.fn(),
      };

      mockGetRequestContext.mockReturnValue(makeRequestContext(""));
      const scope = new CacheScope({ store } as any);
      await scope.lookupRoute("/products/shoes", { slug: "shoes" });
      const key = store.get.mock.calls[0][0];

      expect(key).toContain("slug=shoes");
    });

    it("should produce same key regardless of param insertion order", async () => {
      const store = {
        get: vi.fn().mockResolvedValue(null),
        set: vi.fn(),
      };

      mockGetRequestContext.mockReturnValue(makeRequestContext(""));
      const scope1 = new CacheScope({ store } as any);
      await scope1.lookupRoute("/test", { z: "1", a: "2" });
      const key1 = store.get.mock.calls[0][0];

      store.get.mockClear();
      const scope2 = new CacheScope({ store } as any);
      await scope2.lookupRoute("/test", { a: "2", z: "1" });
      const key2 = store.get.mock.calls[0][0];

      expect(key1).toBe(key2);
    });
  });

  describe("no search params", () => {
    it("should not include query separator when no user-facing params exist", async () => {
      const store = {
        get: vi.fn().mockResolvedValue(null),
        set: vi.fn(),
      };

      mockGetRequestContext.mockReturnValue(makeRequestContext(""));
      const scope = new CacheScope({ store } as any);
      await scope.lookupRoute("/test", {});
      const key = store.get.mock.calls[0][0];

      expect(key).not.toContain("?");
    });

    it("should not include query when only internal params present", async () => {
      const store = {
        get: vi.fn().mockResolvedValue(null),
        set: vi.fn(),
      };

      mockGetRequestContext.mockReturnValue(
        makeRequestContext("?_rsc_partial=1&_rsc_segments=M0L0"),
      );
      const scope = new CacheScope({ store } as any);
      await scope.lookupRoute("/test", {});
      const key = store.get.mock.calls[0][0];

      // Key should have partial prefix but no query part
      expect(key).toMatch(/^partial:\/test$/);
    });
  });

  describe("hard-fail on key() error", () => {
    it("propagates route key() error through CacheScope.lookupRoute", async () => {
      const store = {
        get: vi.fn().mockResolvedValue(null),
        set: vi.fn(),
      };

      mock_getRequestContext.mockReturnValue(
        makeRequestContext(""),
      );
      mockGetRequestContext.mockReturnValue(
        makeRequestContext(""),
      );

      const scope = new CacheScope({
        store,
        key: () => {
          throw new Error("route key exploded");
        },
      } as any);

      await expect(scope.lookupRoute("/test", {})).rejects.toThrow(
        "route key exploded",
      );
      expect(store.get).not.toHaveBeenCalled();
    });
  });
});
