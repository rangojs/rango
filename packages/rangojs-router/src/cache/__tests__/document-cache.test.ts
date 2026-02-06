import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { createDocumentCacheMiddleware } from "../document-cache.js";
import type { MiddlewareContext } from "../../router/middleware.js";

// ============================================================================
// Mock Cache Store
// ============================================================================

interface MockCacheEntry {
  response: Response;
  staleAt: number;
}

function createMockCacheStore() {
  const cache = new Map<string, MockCacheEntry>();

  return {
    cache,
    async getResponse(key: string) {
      const entry = cache.get(key);
      if (!entry) return null;

      const isStale = Date.now() > entry.staleAt;
      return {
        response: entry.response.clone(),
        shouldRevalidate: isStale,
      };
    },
    async putResponse(
      key: string,
      response: Response,
      ttl: number,
      _swr?: number,
    ) {
      cache.set(key, {
        response: response.clone(),
        staleAt: Date.now() + ttl * 1000,
      });
    },
  };
}

// ============================================================================
// Mock Request Context
// ============================================================================

function createMockRequestContext(store: ReturnType<typeof createMockCacheStore>) {
  return {
    _cacheStore: store,
    _onResponseCallbacks: [] as Array<(r: Response) => Response>,
    waitUntil: vi.fn((fn: () => Promise<void>) => {
      fn().catch(() => {});
    }),
  };
}

// ============================================================================
// Mock Middleware Context
// ============================================================================

function createMockMiddlewareContext(
  url: string,
  options: { method?: string; headers?: Record<string, string> } = {},
): MiddlewareContext<any> {
  const parsedUrl = new URL(url, "http://localhost");
  const request = new Request(parsedUrl.toString(), {
    method: options.method ?? "GET",
    headers: options.headers,
  });

  return {
    request,
    url: parsedUrl,
    env: {},
    var: {},
    get: vi.fn(),
    set: vi.fn(),
  } as unknown as MiddlewareContext<any>;
}

// ============================================================================
// Tests
// ============================================================================

describe("createDocumentCacheMiddleware", () => {
  let mockStore: ReturnType<typeof createMockCacheStore>;
  let mockRequestCtx: ReturnType<typeof createMockRequestContext>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));

    mockStore = createMockCacheStore();
    mockRequestCtx = createMockRequestContext(mockStore);

    // Mock getRequestContext to return our mock
    vi.doMock("../../server/request-context.js", () => ({
      getRequestContext: () => mockRequestCtx,
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe("cache miss", () => {
    it("should pass through and cache response with s-maxage", async () => {
      const { createDocumentCacheMiddleware } = await import("../document-cache.js");

      const middleware = createDocumentCacheMiddleware();
      const ctx = createMockMiddlewareContext("http://localhost/page");

      const responseBody = "Hello World";
      const next = vi.fn().mockResolvedValue(
        new Response(responseBody, {
          headers: { "Cache-Control": "s-maxage=60" },
        }),
      );

      // Mock getRequestContext inline
      const originalModule = await import("../../server/request-context.js");
      vi.spyOn(originalModule, "getRequestContext").mockReturnValue(
        mockRequestCtx as any,
      );

      const response = await middleware(ctx, next) as Response;

      expect(next).toHaveBeenCalledTimes(1);
      expect(response.headers.get("x-document-cache-status")).toBe("MISS");
      expect(await response.text()).toBe(responseBody);

      // Wait for background cache write
      await vi.runAllTimersAsync();

      // Verify cached
      expect(mockStore.cache.has("/page:html")).toBe(true);
    });

    it("should not cache response without s-maxage", async () => {
      const { createDocumentCacheMiddleware } = await import("../document-cache.js");

      const middleware = createDocumentCacheMiddleware();
      const ctx = createMockMiddlewareContext("http://localhost/page");

      const next = vi.fn().mockResolvedValue(
        new Response("No cache", {
          headers: { "Cache-Control": "private" },
        }),
      );

      const originalModule = await import("../../server/request-context.js");
      vi.spyOn(originalModule, "getRequestContext").mockReturnValue(
        mockRequestCtx as any,
      );

      const response = await middleware(ctx, next) as Response;

      expect(next).toHaveBeenCalledTimes(1);
      expect(response.headers.has("x-document-cache-status")).toBe(false);
      expect(mockStore.cache.size).toBe(0);
    });
  });

  describe("cache hit", () => {
    it("should return cached response on second request", async () => {
      const { createDocumentCacheMiddleware } = await import("../document-cache.js");

      // Pre-populate cache
      const cachedResponse = new Response("Cached content", {
        headers: { "Cache-Control": "s-maxage=60" },
      });
      mockStore.cache.set("/page:html", {
        response: cachedResponse,
        staleAt: Date.now() + 60 * 1000,
      });

      const middleware = createDocumentCacheMiddleware();
      const ctx = createMockMiddlewareContext("http://localhost/page");
      const next = vi.fn();

      const originalModule = await import("../../server/request-context.js");
      vi.spyOn(originalModule, "getRequestContext").mockReturnValue(
        mockRequestCtx as any,
      );

      const response = await middleware(ctx, next) as Response;

      expect(next).not.toHaveBeenCalled();
      expect(response.headers.get("x-document-cache-status")).toBe("HIT");
      expect(await response.text()).toBe("Cached content");
    });
  });

  describe("stale-while-revalidate", () => {
    it("should return stale response and revalidate in background", async () => {
      const { createDocumentCacheMiddleware } = await import("../document-cache.js");

      // Pre-populate cache with stale entry
      const staleResponse = new Response("Stale content", {
        headers: { "Cache-Control": "s-maxage=60, stale-while-revalidate=300" },
      });
      mockStore.cache.set("/page:html", {
        response: staleResponse,
        staleAt: Date.now() - 1000, // Already stale
      });

      const middleware = createDocumentCacheMiddleware();
      const ctx = createMockMiddlewareContext("http://localhost/page");

      const freshResponse = new Response("Fresh content", {
        headers: { "Cache-Control": "s-maxage=60, stale-while-revalidate=300" },
      });
      const next = vi.fn().mockResolvedValue(freshResponse);

      const originalModule = await import("../../server/request-context.js");
      vi.spyOn(originalModule, "getRequestContext").mockReturnValue(
        mockRequestCtx as any,
      );

      const response = await middleware(ctx, next) as Response;

      // Should return stale content immediately
      expect(response.headers.get("x-document-cache-status")).toBe("STALE");
      expect(await response.text()).toBe("Stale content");

      // Background revalidation should be scheduled
      expect(mockRequestCtx.waitUntil).toHaveBeenCalledTimes(1);

      // Execute background task
      await vi.runAllTimersAsync();

      // next() should have been called for revalidation
      expect(next).toHaveBeenCalledTimes(1);
    });
  });

  describe("skip conditions", () => {
    it("should skip RSC action requests", async () => {
      const { createDocumentCacheMiddleware } = await import("../document-cache.js");

      const middleware = createDocumentCacheMiddleware();
      const ctx = createMockMiddlewareContext(
        "http://localhost/page?_rsc_action=true",
      );

      const next = vi.fn().mockResolvedValue(new Response("Action response"));

      const response = await middleware(ctx, next) as Response;

      expect(next).toHaveBeenCalledTimes(1);
      expect(response.headers.has("x-document-cache-status")).toBe(false);
    });

    it("should skip loader requests", async () => {
      const { createDocumentCacheMiddleware } = await import("../document-cache.js");

      const middleware = createDocumentCacheMiddleware();
      const ctx = createMockMiddlewareContext(
        "http://localhost/page?_rsc_loader=myLoader",
      );

      const next = vi.fn().mockResolvedValue(new Response("Loader response"));

      const response = await middleware(ctx, next) as Response;

      expect(next).toHaveBeenCalledTimes(1);
      expect(response.headers.has("x-document-cache-status")).toBe(false);
    });

    it("should skip configured paths", async () => {
      const { createDocumentCacheMiddleware } = await import("../document-cache.js");

      const middleware = createDocumentCacheMiddleware({
        skipPaths: ["/api", "/admin"],
      });
      const ctx = createMockMiddlewareContext("http://localhost/api/users");

      const next = vi.fn().mockResolvedValue(new Response("API response"));

      const response = await middleware(ctx, next) as Response;

      expect(next).toHaveBeenCalledTimes(1);
      expect(response.headers.has("x-document-cache-status")).toBe(false);
    });

    it("should skip when isEnabled returns false", async () => {
      const { createDocumentCacheMiddleware } = await import("../document-cache.js");

      const middleware = createDocumentCacheMiddleware({
        isEnabled: (ctx) => !ctx.request.headers.has("x-no-cache"),
      });
      const ctx = createMockMiddlewareContext("http://localhost/page", {
        headers: { "x-no-cache": "true" },
      });

      const next = vi.fn().mockResolvedValue(new Response("Response"));

      const response = await middleware(ctx, next) as Response;

      expect(next).toHaveBeenCalledTimes(1);
      expect(response.headers.has("x-document-cache-status")).toBe(false);
    });
  });

  describe("cache key generation", () => {
    it("should use custom key generator", async () => {
      const { createDocumentCacheMiddleware } = await import("../document-cache.js");

      const middleware = createDocumentCacheMiddleware({
        keyGenerator: (url) => `custom:${url.pathname}`,
      });

      // Pre-populate cache with custom key
      const cachedResponse = new Response("Cached", {
        headers: { "Cache-Control": "s-maxage=60" },
      });
      mockStore.cache.set("custom:/page:html", {
        response: cachedResponse,
        staleAt: Date.now() + 60 * 1000,
      });

      const ctx = createMockMiddlewareContext("http://localhost/page");
      const next = vi.fn();

      const originalModule = await import("../../server/request-context.js");
      vi.spyOn(originalModule, "getRequestContext").mockReturnValue(
        mockRequestCtx as any,
      );

      const response = await middleware(ctx, next) as Response;

      expect(next).not.toHaveBeenCalled();
      expect(response.headers.get("x-document-cache-status")).toBe("HIT");
    });

    it("should differentiate RSC partial requests with :rsc suffix", async () => {
      const { createDocumentCacheMiddleware } = await import("../document-cache.js");

      // Pre-populate HTML cache
      const htmlResponse = new Response("HTML", {
        headers: { "Cache-Control": "s-maxage=60" },
      });
      mockStore.cache.set("/page:html", {
        response: htmlResponse,
        staleAt: Date.now() + 60 * 1000,
      });

      const middleware = createDocumentCacheMiddleware();

      // RSC partial request should miss (different key)
      const ctx = createMockMiddlewareContext(
        "http://localhost/page?_rsc_partial=true",
      );
      const next = vi.fn().mockResolvedValue(
        new Response("RSC", {
          headers: { "Cache-Control": "s-maxage=60" },
        }),
      );

      const originalModule = await import("../../server/request-context.js");
      vi.spyOn(originalModule, "getRequestContext").mockReturnValue(
        mockRequestCtx as any,
      );

      const response = await middleware(ctx, next) as Response;

      // Should be a MISS since RSC key is different
      expect(next).toHaveBeenCalledTimes(1);
      expect(response.headers.get("x-document-cache-status")).toBe("MISS");
    });

    it("should include segment hash in cache key for partial requests", async () => {
      const { createDocumentCacheMiddleware } = await import("../document-cache.js");

      const middleware = createDocumentCacheMiddleware();

      // First partial request with segments A,B
      const ctx1 = createMockMiddlewareContext(
        "http://localhost/page?_rsc_partial=true&_rsc_segments=root,blog-layout",
      );
      const next1 = vi.fn().mockResolvedValue(
        new Response("Response for blog navigation", {
          headers: { "Cache-Control": "s-maxage=60" },
        }),
      );

      const originalModule = await import("../../server/request-context.js");
      vi.spyOn(originalModule, "getRequestContext").mockReturnValue(
        mockRequestCtx as any,
      );

      await middleware(ctx1, next1);
      await vi.runAllTimersAsync();

      // Second partial request with different segments
      const ctx2 = createMockMiddlewareContext(
        "http://localhost/page?_rsc_partial=true&_rsc_segments=root,shop-layout",
      );
      const next2 = vi.fn().mockResolvedValue(
        new Response("Response for shop navigation", {
          headers: { "Cache-Control": "s-maxage=60" },
        }),
      );

      const response2 = await middleware(ctx2, next2) as Response;

      // Should be a MISS because different segments = different cache key
      expect(next2).toHaveBeenCalledTimes(1);
      expect(response2.headers.get("x-document-cache-status")).toBe("MISS");
    });
  });

  describe("debug logging", () => {
    it("should not log when debug is false", async () => {
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const { createDocumentCacheMiddleware } = await import("../document-cache.js");

      const middleware = createDocumentCacheMiddleware({ debug: false });
      const ctx = createMockMiddlewareContext("http://localhost/page");

      const next = vi.fn().mockResolvedValue(
        new Response("Response", {
          headers: { "Cache-Control": "s-maxage=60" },
        }),
      );

      const originalModule = await import("../../server/request-context.js");
      vi.spyOn(originalModule, "getRequestContext").mockReturnValue(
        mockRequestCtx as any,
      );

      await middleware(ctx, next);

      expect(consoleSpy).not.toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it("should log when debug is true", async () => {
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const { createDocumentCacheMiddleware } = await import("../document-cache.js");

      const middleware = createDocumentCacheMiddleware({ debug: true });
      const ctx = createMockMiddlewareContext("http://localhost/page");

      const next = vi.fn().mockResolvedValue(
        new Response("Response", {
          headers: { "Cache-Control": "s-maxage=60" },
        }),
      );

      const originalModule = await import("../../server/request-context.js");
      vi.spyOn(originalModule, "getRequestContext").mockReturnValue(
        mockRequestCtx as any,
      );

      await middleware(ctx, next);

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("[DocumentCache] MISS"),
      );
      consoleSpy.mockRestore();
    });
  });

  describe("error handling", () => {
    it("should fall through to handler on cache error", async () => {
      const { createDocumentCacheMiddleware } = await import("../document-cache.js");

      // Create a store that throws on getResponse
      const brokenStore = {
        async getResponse() {
          throw new Error("Cache unavailable");
        },
        async putResponse() {},
      };
      const brokenCtx = createMockRequestContext(brokenStore as any);

      const middleware = createDocumentCacheMiddleware();
      const ctx = createMockMiddlewareContext("http://localhost/page");

      const next = vi.fn().mockResolvedValue(new Response("Fallback"));

      const originalModule = await import("../../server/request-context.js");
      vi.spyOn(originalModule, "getRequestContext").mockReturnValue(
        brokenCtx as any,
      );

      const response = await middleware(ctx, next) as Response;

      expect(next).toHaveBeenCalledTimes(1);
      expect(await response.text()).toBe("Fallback");
    });
  });

  describe("no cache store", () => {
    it("should pass through when no cache store is configured", async () => {
      const { createDocumentCacheMiddleware } = await import("../document-cache.js");

      const noCacheCtx = {
        _cacheStore: undefined,
        _onResponseCallbacks: [],
        waitUntil: vi.fn(),
      };

      const middleware = createDocumentCacheMiddleware();
      const ctx = createMockMiddlewareContext("http://localhost/page");

      const next = vi.fn().mockResolvedValue(new Response("Response"));

      const originalModule = await import("../../server/request-context.js");
      vi.spyOn(originalModule, "getRequestContext").mockReturnValue(
        noCacheCtx as any,
      );

      const response = await middleware(ctx, next) as Response;

      expect(next).toHaveBeenCalledTimes(1);
      expect(response.headers.has("x-document-cache-status")).toBe(false);
    });
  });
});
