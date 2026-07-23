import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { createDocumentCacheMiddleware } from "../document-cache.js";
import type { MiddlewareContext } from "../../router/middleware.js";
// The REAL cacheTag + runWithRequestContext (statically bound before the
// per-test vi.doMock of request-context, so they use the real ALS). Lets a
// render call the render-callable cacheTag() and land the tag on the same
// _requestTags the middleware collects (#648).
import { cacheTag } from "../cache-tag.js";
import { runWithRequestContext } from "../../server/request-context.js";

// ============================================================================
// Mock Cache Store
// ============================================================================

interface MockCacheEntry {
  response: Response;
  staleAt: number;
  tags?: string[];
}

function createMockCacheStore() {
  const cache = new Map<string, MockCacheEntry>();
  const putResponseTags: (string[] | undefined)[] = [];

  return {
    cache,
    putResponseTags,
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
      tags?: string[],
    ) {
      putResponseTags.push(tags);
      cache.set(key, {
        response: response.clone(),
        staleAt: Date.now() + ttl * 1000,
        tags,
      });
    },
  };
}

// ============================================================================
// Mock Request Context
// ============================================================================

function createMockRequestContext(
  store: ReturnType<typeof createMockCacheStore>,
) {
  return {
    _cacheStore: store,
    _onResponseCallbacks: [] as Array<(r: Response) => Response>,
    // Mirror production: a settled render barrier and the request-scoped tag set
    // the document cache snapshots for tag invalidation.
    _handleStore: { settled: Promise.resolve() },
    _requestTags: new Set<string>(),
    waitUntil: vi.fn((fn: () => Promise<void>) => {
      fn().catch(() => {});
    }),
    // Router onError seam: reportCacheError routes background failures here when
    // the captured requestCtx is passed (the ALS is gone in a waitUntil task).
    _reportBackgroundError: vi.fn(),
  };
}

// ============================================================================
// Mock Middleware Context
// ============================================================================

/**
 * Create a mock middleware context that mirrors production behavior:
 * - ctx.request.url: raw URL with all params (including _rsc*)
 * - ctx.url: stripped URL without _rsc* params (as stripInternalParams does)
 *
 * The document cache middleware must use ctx.request.url for _rsc* detection
 * since ctx.url has them stripped by the middleware pipeline.
 */
function createMockMiddlewareContext(
  url: string,
  options: { method?: string; headers?: Record<string, string> } = {},
): MiddlewareContext<any> {
  const rawUrl = new URL(url, "http://localhost");
  const request = new Request(rawUrl.toString(), {
    method: options.method ?? "GET",
    headers: options.headers,
  });

  // Simulate stripInternalParams: remove _rsc* params from ctx.url
  const strippedUrl = new URL(rawUrl);
  for (const key of [...strippedUrl.searchParams.keys()]) {
    if (key.startsWith("_rsc")) {
      strippedUrl.searchParams.delete(key);
    }
  }

  return {
    request,
    url: strippedUrl,
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

    // Mock getRequestContext to return our mock. runWithRequestContext is
    // exercised by the background document revalidation (it re-establishes the
    // request-context ALS around next()); delegate to the REAL implementation
    // (statically imported above, real ALS) so ambient reads inside the
    // background task — observePhase's _getRequestContext for the
    // rango.background span, ctx.rendered() gating — resolve the threaded
    // context exactly like production. _getRequestContext mirrors that for
    // importers bound to this mocked registry.
    vi.doMock("../../server/request-context.js", () => ({
      getRequestContext: () => mockRequestCtx,
      _getRequestContext: () => mockRequestCtx,
      runWithRequestContext,
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe("cache miss", () => {
    it("should pass through and cache response with s-maxage", async () => {
      const { createDocumentCacheMiddleware } =
        await import("../document-cache.js");

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

      const response = (await middleware(ctx, next)) as Response;

      expect(next).toHaveBeenCalledTimes(1);
      expect(response.headers.get("x-document-cache-status")).toBe("MISS");
      expect(await response.text()).toBe(responseBody);

      // Wait for background cache write
      await vi.runAllTimersAsync();

      // Verify cached
      expect(mockStore.cache.has("localhost/page:html")).toBe(true);
    });

    it("tags the document entry with the request-scoped tag union (#1)", async () => {
      const { createDocumentCacheMiddleware } =
        await import("../document-cache.js");

      const middleware = createDocumentCacheMiddleware();
      const ctx = createMockMiddlewareContext("http://localhost/page");

      // Simulate cache()/cacheTag()/loader recordRequestTags() having run during
      // render: the request-scoped set holds the page's tags before settle.
      mockRequestCtx._requestTags.add("products");
      mockRequestCtx._requestTags.add("nav");

      const next = vi.fn().mockResolvedValue(
        new Response("Tagged", {
          headers: { "Cache-Control": "s-maxage=60" },
        }),
      );

      const originalModule = await import("../../server/request-context.js");
      vi.spyOn(originalModule, "getRequestContext").mockReturnValue(
        mockRequestCtx as any,
      );

      await middleware(ctx, next);
      await vi.runAllTimersAsync();

      // putResponse received the tag union as its 5th argument, so updateTag()
      // can invalidate the full-page entry.
      expect(mockStore.putResponseTags).toHaveLength(1);
      expect(mockStore.putResponseTags[0]).toEqual(["products", "nav"]);
      expect(mockStore.cache.get("localhost/page:html")?.tags).toEqual([
        "products",
        "nav",
      ]);
    });

    it("collects a render-called cacheTag() onto the document entry (#648)", async () => {
      const { createDocumentCacheMiddleware } =
        await import("../document-cache.js");

      const middleware = createDocumentCacheMiddleware();
      const ctx = createMockMiddlewareContext("http://localhost/page");

      // The render (next()) calls the REAL render-callable cacheTag with the same
      // request context active on the ALS — before #648 this threw outside a "use
      // cache" scope. The tag lands on mockRequestCtx._requestTags, which the
      // middleware then snapshots into the document entry.
      const next = vi.fn(async () => {
        runWithRequestContext(mockRequestCtx as any, () =>
          cacheTag("render-tag"),
        );
        return new Response("Tagged by render", {
          headers: { "Cache-Control": "s-maxage=60" },
        });
      });

      const originalModule = await import("../../server/request-context.js");
      vi.spyOn(originalModule, "getRequestContext").mockReturnValue(
        mockRequestCtx as any,
      );

      await middleware(ctx, next);
      await vi.runAllTimersAsync();

      expect(mockStore.putResponseTags).toHaveLength(1);
      expect(mockStore.putResponseTags[0]).toEqual(["render-tag"]);
      expect(mockStore.cache.get("localhost/page:html")?.tags).toEqual([
        "render-tag",
      ]);
    });

    it("passes undefined tags for an untagged document (header-free)", async () => {
      const { createDocumentCacheMiddleware } =
        await import("../document-cache.js");

      const middleware = createDocumentCacheMiddleware();
      const ctx = createMockMiddlewareContext("http://localhost/page");

      const next = vi.fn().mockResolvedValue(
        new Response("Untagged", {
          headers: { "Cache-Control": "s-maxage=60" },
        }),
      );

      const originalModule = await import("../../server/request-context.js");
      vi.spyOn(originalModule, "getRequestContext").mockReturnValue(
        mockRequestCtx as any,
      );

      await middleware(ctx, next);
      await vi.runAllTimersAsync();

      expect(mockStore.putResponseTags[0]).toBeUndefined();
    });

    it("should handle cacheable response with null body without throwing", async () => {
      const { createDocumentCacheMiddleware } =
        await import("../document-cache.js");

      const middleware = createDocumentCacheMiddleware();
      const ctx = createMockMiddlewareContext("http://localhost/page");

      // A 200 response with cache headers but null body (e.g., from a redirect proxy)
      const nullBodyResponse = new Response(null, {
        status: 200,
        headers: { "Cache-Control": "s-maxage=60" },
      });

      const next = vi.fn().mockResolvedValue(nullBodyResponse);

      const originalModule = await import("../../server/request-context.js");
      vi.spyOn(originalModule, "getRequestContext").mockReturnValue(
        mockRequestCtx as any,
      );

      // Must not throw even though body is null
      const response = (await middleware(ctx, next)) as Response;

      expect(next).toHaveBeenCalledTimes(1);
      // Returns the original response as-is (no caching attempted)
      expect(response).toBe(nullBodyResponse);
      // No cache entry written
      expect(mockStore.cache.size).toBe(0);
    });

    it("should not cache response without s-maxage", async () => {
      const { createDocumentCacheMiddleware } =
        await import("../document-cache.js");

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

      const response = (await middleware(ctx, next)) as Response;

      expect(next).toHaveBeenCalledTimes(1);
      expect(response.headers.has("x-document-cache-status")).toBe(false);
      expect(mockStore.cache.size).toBe(0);
    });

    it("should not cache a response carrying Set-Cookie (Finding #3)", async () => {
      const { createDocumentCacheMiddleware } =
        await import("../document-cache.js");

      const middleware = createDocumentCacheMiddleware();
      const ctx = createMockMiddlewareContext("http://localhost/page");

      // s-maxage says cacheable, but the per-client Set-Cookie must veto it: a
      // shared store would replay the cookie to every client on a hit.
      const next = vi.fn().mockResolvedValue(
        new Response("per-client", {
          headers: {
            "Cache-Control": "s-maxage=60",
            "Set-Cookie": "rango-state_router_0=v1:123; Path=/",
          },
        }),
      );

      const originalModule = await import("../../server/request-context.js");
      vi.spyOn(originalModule, "getRequestContext").mockReturnValue(
        mockRequestCtx as any,
      );

      await middleware(ctx, next);
      await vi.runAllTimersAsync();

      expect(mockStore.cache.size).toBe(0);
    });

    it("should not cache a response carrying x-rango-keep-cache (Finding #3 mirror)", async () => {
      const { createDocumentCacheMiddleware } =
        await import("../document-cache.js");

      const middleware = createDocumentCacheMiddleware();
      const ctx = createMockMiddlewareContext("http://localhost/page");

      const next = vi.fn().mockResolvedValue(
        new Response("keep", {
          headers: {
            "Cache-Control": "s-maxage=60",
            "x-rango-keep-cache": "1",
          },
        }),
      );

      const originalModule = await import("../../server/request-context.js");
      vi.spyOn(originalModule, "getRequestContext").mockReturnValue(
        mockRequestCtx as any,
      );

      await middleware(ctx, next);
      await vi.runAllTimersAsync();

      expect(mockStore.cache.size).toBe(0);
    });

    it("should not store a private response in the shared cache even with s-maxage (RFC 7234)", async () => {
      const { createDocumentCacheMiddleware } =
        await import("../document-cache.js");

      const middleware = createDocumentCacheMiddleware();
      const ctx = createMockMiddlewareContext("http://localhost/page");

      // `private` forbids shared storage and MUST win over the contradictory
      // s-maxage. The store must stay empty and the response must pass through
      // untagged (directives parse to null, so not even a MISS is recorded).
      const next = vi.fn().mockResolvedValue(
        new Response("private body", {
          headers: { "Cache-Control": "private, s-maxage=60" },
        }),
      );

      const originalModule = await import("../../server/request-context.js");
      vi.spyOn(originalModule, "getRequestContext").mockReturnValue(
        mockRequestCtx as any,
      );

      const response = (await middleware(ctx, next)) as Response;
      await vi.runAllTimersAsync();

      expect(mockStore.cache.size).toBe(0);
      expect(response.headers.has("x-document-cache-status")).toBe(false);
    });

    it("should not store a no-store response in the shared cache even with s-maxage (RFC 7234)", async () => {
      const { createDocumentCacheMiddleware } =
        await import("../document-cache.js");

      const middleware = createDocumentCacheMiddleware();
      const ctx = createMockMiddlewareContext("http://localhost/page");

      const next = vi.fn().mockResolvedValue(
        new Response("no-store body", {
          headers: { "Cache-Control": "no-store, s-maxage=60" },
        }),
      );

      const originalModule = await import("../../server/request-context.js");
      vi.spyOn(originalModule, "getRequestContext").mockReturnValue(
        mockRequestCtx as any,
      );

      const response = (await middleware(ctx, next)) as Response;
      await vi.runAllTimersAsync();

      expect(mockStore.cache.size).toBe(0);
      expect(response.headers.has("x-document-cache-status")).toBe(false);
    });

    it("should not store an unqualified no-cache response even with s-maxage (RFC 7234 §5.2.2.2)", async () => {
      const { createDocumentCacheMiddleware } =
        await import("../document-cache.js");

      const middleware = createDocumentCacheMiddleware();
      const ctx = createMockMiddlewareContext("http://localhost/page");

      // `no-cache` means a shared cache MUST revalidate at the origin before
      // serving. The store's hit path has no validation step, so serving a
      // stored no-cache response within s-maxage would hand the client content
      // the origin marked must-revalidate. Refuse to store it.
      const next = vi.fn().mockResolvedValue(
        new Response("no-cache body", {
          headers: { "Cache-Control": "no-cache, s-maxage=60" },
        }),
      );

      const originalModule = await import("../../server/request-context.js");
      vi.spyOn(originalModule, "getRequestContext").mockReturnValue(
        mockRequestCtx as any,
      );

      const response = (await middleware(ctx, next)) as Response;
      await vi.runAllTimersAsync();

      expect(mockStore.cache.size).toBe(0);
      expect(response.headers.has("x-document-cache-status")).toBe(false);
    });

    it("still stores a field-name-qualified no-cache response (RFC nuance)", async () => {
      const { createDocumentCacheMiddleware } =
        await import("../document-cache.js");

      const middleware = createDocumentCacheMiddleware();
      const ctx = createMockMiddlewareContext("http://localhost/page");

      // `no-cache="set-cookie"` scopes the directive to a single field and is
      // storable per RFC 7234 — only the qualified field must be stripped on
      // serve, not the whole response. The veto excludes the `=` boundary so
      // this qualified form does NOT veto storage.
      const next = vi.fn().mockResolvedValue(
        new Response("qualified no-cache body", {
          headers: { "Cache-Control": 'no-cache="set-cookie", s-maxage=60' },
        }),
      );

      const originalModule = await import("../../server/request-context.js");
      vi.spyOn(originalModule, "getRequestContext").mockReturnValue(
        mockRequestCtx as any,
      );

      const response = (await middleware(ctx, next)) as Response;
      await vi.runAllTimersAsync();

      expect(response.headers.get("x-document-cache-status")).toBe("MISS");
      expect(mockStore.cache.has("localhost/page:html")).toBe(true);
    });
  });

  describe("cache hit", () => {
    it("should return cached response on second request", async () => {
      const { createDocumentCacheMiddleware } =
        await import("../document-cache.js");

      // Pre-populate cache
      const cachedResponse = new Response("Cached content", {
        headers: { "Cache-Control": "s-maxage=60" },
      });
      mockStore.cache.set("localhost/page:html", {
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

      const response = (await middleware(ctx, next)) as Response;

      expect(next).not.toHaveBeenCalled();
      expect(response.headers.get("x-document-cache-status")).toBe("HIT");
      expect(await response.text()).toBe("Cached content");
    });

    it("adds the status header without corrupting the body across repeat hits", async () => {
      // addCacheStatusHeader mutates the response headers in place (the store
      // hands back a fresh Response per get), so two sequential hits must each
      // carry the HIT header AND the intact body — the first mutation must not
      // poison the stored entry for the second.
      const { createDocumentCacheMiddleware } =
        await import("../document-cache.js");

      const cachedResponse = new Response("Repeat body", {
        headers: { "Cache-Control": "s-maxage=60" },
      });
      mockStore.cache.set("localhost/page:html", {
        response: cachedResponse,
        staleAt: Date.now() + 60 * 1000,
      });

      const middleware = createDocumentCacheMiddleware();
      const next = vi.fn();
      const originalModule = await import("../../server/request-context.js");
      vi.spyOn(originalModule, "getRequestContext").mockReturnValue(
        mockRequestCtx as any,
      );

      const first = (await middleware(
        createMockMiddlewareContext("http://localhost/page"),
        next,
      )) as Response;
      const second = (await middleware(
        createMockMiddlewareContext("http://localhost/page"),
        next,
      )) as Response;

      expect(first.headers.get("x-document-cache-status")).toBe("HIT");
      expect(second.headers.get("x-document-cache-status")).toBe("HIT");
      expect(await first.text()).toBe("Repeat body");
      expect(await second.text()).toBe("Repeat body");
    });
  });

  describe("stale-while-revalidate", () => {
    it("should return stale response and revalidate in background", async () => {
      const { createDocumentCacheMiddleware } =
        await import("../document-cache.js");
      const { resolveTracing } = await import("../../router/tracing.js");
      const spans: Array<{
        name: string;
        attributes: Record<string, unknown>;
      }> = [];
      (mockRequestCtx as any)._tracing = resolveTracing({
        runner: (name, fn) => {
          const record = { name, attributes: {} as Record<string, unknown> };
          spans.push(record);
          return fn({
            setAttribute(key, value) {
              record.attributes[key] = value;
            },
          });
        },
      });

      // Capture the background task WITHOUT invoking it (the shared harness
      // mock runs it inline), so the foreground/background split is
      // deterministic for the span assertions below.
      const backgroundTasks: Array<() => Promise<void>> = [];
      (mockRequestCtx as any).waitUntil = vi.fn((fn: () => Promise<void>) => {
        backgroundTasks.push(fn);
      });

      // Pre-populate cache with stale entry
      const staleResponse = new Response("Stale content", {
        headers: { "Cache-Control": "s-maxage=60, stale-while-revalidate=300" },
      });
      mockStore.cache.set("localhost/page:html", {
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

      const response = (await middleware(ctx, next)) as Response;

      // Should return stale content immediately
      expect(response.headers.get("x-document-cache-status")).toBe("STALE");
      expect(await response.text()).toBe("Stale content");

      // Background revalidation should be scheduled but not yet run: no
      // rango.background span exists before the task executes.
      expect(mockRequestCtx.waitUntil).toHaveBeenCalledTimes(1);
      expect(spans).toHaveLength(0);

      // Execute background task
      await backgroundTasks[0]!();

      // next() should have been called for revalidation
      expect(next).toHaveBeenCalledTimes(1);
      expect(spans.map((span) => span.name)).toEqual(["rango.background"]);
      expect(spans[0].attributes["rango.background.kind"]).toBe(
        "document-revalidation",
      );
    });

    it("reports a background revalidation write failure via _reportBackgroundError (captured requestCtx)", async () => {
      const { createDocumentCacheMiddleware } =
        await import("../document-cache.js");

      // Stale entry so the request serves stale + revalidates in the background.
      const staleResponse = new Response("Stale content", {
        headers: { "Cache-Control": "s-maxage=60, stale-while-revalidate=300" },
      });
      mockStore.cache.set("localhost/page:html", {
        response: staleResponse,
        staleAt: Date.now() - 1000,
      });
      // The detached background write fails.
      const writeError = new Error("putResponse boom");
      mockStore.putResponse = vi.fn().mockRejectedValue(writeError);

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

      await middleware(ctx, next);
      await vi.runAllTimersAsync();

      // The failure surfaced through onError because reportCacheError received
      // the captured requestCtx — in a waitUntil task the ALS context is gone,
      // so its _getRequestContext() fallback would be null and the error would
      // only log.
      expect(mockRequestCtx._reportBackgroundError).toHaveBeenCalledWith(
        writeError,
        "cache-write",
      );
    });
  });

  describe("skip conditions", () => {
    it("should skip RSC action requests", async () => {
      const { createDocumentCacheMiddleware } =
        await import("../document-cache.js");

      const middleware = createDocumentCacheMiddleware();
      const ctx = createMockMiddlewareContext(
        "http://localhost/page?_rsc_action=true",
      );

      const next = vi.fn().mockResolvedValue(new Response("Action response"));

      const response = (await middleware(ctx, next)) as Response;

      expect(next).toHaveBeenCalledTimes(1);
      expect(response.headers.has("x-document-cache-status")).toBe(false);
    });

    it("should skip loader requests", async () => {
      const { createDocumentCacheMiddleware } =
        await import("../document-cache.js");

      const middleware = createDocumentCacheMiddleware();
      const ctx = createMockMiddlewareContext(
        "http://localhost/page?_rsc_loader=myLoader",
      );

      const next = vi.fn().mockResolvedValue(new Response("Loader response"));

      const response = (await middleware(ctx, next)) as Response;

      expect(next).toHaveBeenCalledTimes(1);
      expect(response.headers.has("x-document-cache-status")).toBe(false);
    });

    it("should skip configured paths", async () => {
      const { createDocumentCacheMiddleware } =
        await import("../document-cache.js");

      const middleware = createDocumentCacheMiddleware({
        skipPaths: ["/api", "/admin"],
      });
      const ctx = createMockMiddlewareContext("http://localhost/api/users");

      const next = vi.fn().mockResolvedValue(new Response("API response"));

      const response = (await middleware(ctx, next)) as Response;

      expect(next).toHaveBeenCalledTimes(1);
      expect(response.headers.has("x-document-cache-status")).toBe(false);
    });

    it("should skip non-GET requests", async () => {
      const { createDocumentCacheMiddleware } =
        await import("../document-cache.js");

      const middleware = createDocumentCacheMiddleware();

      for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
        const ctx = createMockMiddlewareContext("http://localhost/page", {
          method,
        });

        const next = vi
          .fn()
          .mockResolvedValue(new Response("Mutation response"));

        const response = (await middleware(ctx, next)) as Response;

        expect(next).toHaveBeenCalledTimes(1);
        expect(response.headers.has("x-document-cache-status")).toBe(false);
      }
    });

    it("should not serve cached response for POST request", async () => {
      const { createDocumentCacheMiddleware } =
        await import("../document-cache.js");

      // Pre-populate cache for the path
      const cachedResponse = new Response("Cached GET", {
        headers: { "Cache-Control": "s-maxage=60" },
      });
      mockStore.cache.set("localhost/page:html", {
        response: cachedResponse,
        staleAt: Date.now() + 60 * 1000,
      });

      const middleware = createDocumentCacheMiddleware();
      const ctx = createMockMiddlewareContext("http://localhost/page", {
        method: "POST",
      });

      const next = vi.fn().mockResolvedValue(new Response("POST result"));

      const originalModule = await import("../../server/request-context.js");
      vi.spyOn(originalModule, "getRequestContext").mockReturnValue(
        mockRequestCtx as any,
      );

      const response = (await middleware(ctx, next)) as Response;

      // Must call next() and NOT return the cached GET response
      expect(next).toHaveBeenCalledTimes(1);
      expect(await response.text()).toBe("POST result");
      expect(response.headers.has("x-document-cache-status")).toBe(false);
    });

    it("should skip when isEnabled returns false", async () => {
      const { createDocumentCacheMiddleware } =
        await import("../document-cache.js");

      const middleware = createDocumentCacheMiddleware({
        isEnabled: (ctx) => !ctx.request.headers.has("x-no-cache"),
      });
      const ctx = createMockMiddlewareContext("http://localhost/page", {
        headers: { "x-no-cache": "true" },
      });

      const next = vi.fn().mockResolvedValue(new Response("Response"));

      const response = (await middleware(ctx, next)) as Response;

      expect(next).toHaveBeenCalledTimes(1);
      expect(response.headers.has("x-document-cache-status")).toBe(false);
    });
  });

  describe("cache key generation", () => {
    it("should use custom key generator", async () => {
      const { createDocumentCacheMiddleware } =
        await import("../document-cache.js");

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

      const response = (await middleware(ctx, next)) as Response;

      expect(next).not.toHaveBeenCalled();
      expect(response.headers.get("x-document-cache-status")).toBe("HIT");
    });

    it("should differentiate RSC partial requests with :rsc suffix", async () => {
      const { createDocumentCacheMiddleware } =
        await import("../document-cache.js");

      // Pre-populate HTML cache
      const htmlResponse = new Response("HTML", {
        headers: { "Cache-Control": "s-maxage=60" },
      });
      mockStore.cache.set("localhost/page:html", {
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

      const response = (await middleware(ctx, next)) as Response;

      // Should be a MISS since RSC key is different
      expect(next).toHaveBeenCalledTimes(1);
      expect(response.headers.get("x-document-cache-status")).toBe("MISS");
    });

    it("should differentiate Accept-based RSC requests from HTML document requests", async () => {
      const { createDocumentCacheMiddleware } =
        await import("../document-cache.js");

      const middleware = createDocumentCacheMiddleware();

      const originalModule = await import("../../server/request-context.js");
      vi.spyOn(originalModule, "getRequestContext").mockReturnValue(
        mockRequestCtx as any,
      );

      const rscCtx = createMockMiddlewareContext("http://localhost/page", {
        headers: { Accept: "text/x-component" },
      });
      const rscNext = vi.fn().mockResolvedValue(
        new Response("RSC", {
          headers: { "Cache-Control": "s-maxage=60" },
        }),
      );

      await middleware(rscCtx, rscNext);
      await vi.runAllTimersAsync();

      const htmlCtx = createMockMiddlewareContext("http://localhost/page", {
        headers: { Accept: "text/html" },
      });
      const htmlNext = vi.fn().mockResolvedValue(
        new Response("HTML", {
          headers: { "Cache-Control": "s-maxage=60" },
        }),
      );

      const response = (await middleware(htmlCtx, htmlNext)) as Response;
      // The document write is a background task (now gated on the render barrier
      // before snapshotting tags), so flush before asserting it landed.
      await vi.runAllTimersAsync();

      expect(htmlNext).toHaveBeenCalledTimes(1);
      expect(response.headers.get("x-document-cache-status")).toBe("MISS");
      expect(mockStore.cache.has("localhost/page:rsc")).toBe(true);
      expect(mockStore.cache.has("localhost/page:html")).toBe(true);
    });

    it("should include segment hash in cache key for partial requests", async () => {
      const { createDocumentCacheMiddleware } =
        await import("../document-cache.js");

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

      const response2 = (await middleware(ctx2, next2)) as Response;

      // Should be a MISS because different segments = different cache key
      expect(next2).toHaveBeenCalledTimes(1);
      expect(response2.headers.get("x-document-cache-status")).toBe("MISS");
    });

    it("separates fragment-capable partial responses from context-less clients", async () => {
      const { createDocumentCacheMiddleware } =
        await import("../document-cache.js");
      const middleware = createDocumentCacheMiddleware();
      const url =
        "http://localhost/page?_rsc_partial=true&_rsc_segments=root,layout";

      const originalModule = await import("../../server/request-context.js");
      vi.spyOn(originalModule, "getRequestContext").mockReturnValue(
        mockRequestCtx as any,
      );

      const capableCtx = createMockMiddlewareContext(url, {
        headers: { "X-Rango-Fragment-Passthrough": "1" },
      });
      const capableNext = vi.fn().mockResolvedValue(
        new Response("fragment envelopes", {
          headers: { "Cache-Control": "s-maxage=60" },
        }),
      );
      await middleware(capableCtx, capableNext);
      await vi.runAllTimersAsync();

      const probeCtx = createMockMiddlewareContext(url);
      const probeNext = vi.fn().mockResolvedValue(
        new Response("decoded elements", {
          headers: { "Cache-Control": "s-maxage=60" },
        }),
      );
      const probeResponse = (await middleware(probeCtx, probeNext)) as Response;

      expect(probeNext).toHaveBeenCalledTimes(1);
      expect(probeResponse.headers.get("x-document-cache-status")).toBe("MISS");
      expect(await probeResponse.text()).toBe("decoded elements");
    });

    it("bypasses an existing response-cache hit during fragment recovery", async () => {
      const { createDocumentCacheMiddleware } =
        await import("../document-cache.js");
      const middleware = createDocumentCacheMiddleware();
      const url =
        "http://localhost/page?_rsc_partial=true&_rsc_segments=root,layout";

      const originalModule = await import("../../server/request-context.js");
      vi.spyOn(originalModule, "getRequestContext").mockReturnValue(
        mockRequestCtx as any,
      );

      const cachedCtx = createMockMiddlewareContext(url, {
        headers: { "X-Rango-Fragment-Passthrough": "1" },
      });
      await middleware(
        cachedCtx,
        vi.fn().mockResolvedValue(
          new Response("cached response", {
            headers: { "Cache-Control": "s-maxage=60" },
          }),
        ),
      );
      await vi.runAllTimersAsync();

      const recoveryCtx = createMockMiddlewareContext(url, {
        headers: { "X-Rango-Fragment-Recovery": "1" },
      });
      const recoveryNext = vi.fn().mockResolvedValue(
        new Response("server-decoded recovery", {
          headers: { "Cache-Control": "s-maxage=60" },
        }),
      );
      const response = (await middleware(
        recoveryCtx,
        recoveryNext,
      )) as Response;

      expect(recoveryNext).toHaveBeenCalledTimes(1);
      expect(response.headers.get("x-document-cache-status")).toBe("MISS");
      expect(await response.text()).toBe("server-decoded recovery");
      await vi.runAllTimersAsync();

      const capableAgain = createMockMiddlewareContext(url, {
        headers: { "X-Rango-Fragment-Passthrough": "1" },
      });
      const shouldNotRun = vi.fn();
      const replaced = (await middleware(
        capableAgain,
        shouldNotRun,
      )) as Response;

      expect(shouldNotRun).not.toHaveBeenCalled();
      expect(replaced.headers.get("x-document-cache-status")).toBe("HIT");
      expect(await replaced.text()).toBe("server-decoded recovery");
    });

    it("should scope default cache key by user-facing search params", async () => {
      const { createDocumentCacheMiddleware } =
        await import("../document-cache.js");

      const middleware = createDocumentCacheMiddleware();

      const originalModule = await import("../../server/request-context.js");
      vi.spyOn(originalModule, "getRequestContext").mockReturnValue(
        mockRequestCtx as any,
      );

      // Cache page=1
      const ctx1 = createMockMiddlewareContext("http://localhost/page?page=1");
      const next1 = vi.fn().mockResolvedValue(
        new Response("Page 1", {
          headers: { "Cache-Control": "s-maxage=60" },
        }),
      );
      await middleware(ctx1, next1);
      await vi.runAllTimersAsync();

      // page=2 should be a MISS (different key)
      const ctx2 = createMockMiddlewareContext("http://localhost/page?page=2");
      const next2 = vi.fn().mockResolvedValue(
        new Response("Page 2", {
          headers: { "Cache-Control": "s-maxage=60" },
        }),
      );
      const response2 = (await middleware(ctx2, next2)) as Response;
      expect(next2).toHaveBeenCalledTimes(1);
      expect(response2.headers.get("x-document-cache-status")).toBe("MISS");
    });

    it("should ignore internal _rsc* and __no_cache query params in default key", async () => {
      const { createDocumentCacheMiddleware } =
        await import("../document-cache.js");

      const middleware = createDocumentCacheMiddleware();

      const originalModule = await import("../../server/request-context.js");
      vi.spyOn(originalModule, "getRequestContext").mockReturnValue(
        mockRequestCtx as any,
      );

      // Cache entry with internal query params present. A4: only `_rsc*` and the
      // reserved `__no_cache` are internal; a generic `__`-prefixed param is a
      // consumer param and keys the cache, so it is no longer used here.
      const withInternal = createMockMiddlewareContext(
        "http://localhost/page?tab=all&__no_cache=1&_rsc_v=abc",
      );
      const next1 = vi.fn().mockResolvedValue(
        new Response("Tabbed", {
          headers: { "Cache-Control": "s-maxage=60" },
        }),
      );
      await middleware(withInternal, next1);
      await vi.runAllTimersAsync();

      // Same user-facing query, without internal params, should HIT same key
      const withoutInternal = createMockMiddlewareContext(
        "http://localhost/page?tab=all",
      );
      const next2 = vi.fn();
      const response2 = (await middleware(withoutInternal, next2)) as Response;

      expect(next2).not.toHaveBeenCalled();
      expect(response2.headers.get("x-document-cache-status")).toBe("HIT");
      expect(await response2.text()).toBe("Tabbed");
    });
  });

  describe("host isolation (multi-domain)", () => {
    it("isolates the default key by host so one hostname never serves another", async () => {
      const { createDocumentCacheMiddleware } =
        await import("../document-cache.js");

      const middleware = createDocumentCacheMiddleware();

      const originalModule = await import("../../server/request-context.js");
      vi.spyOn(originalModule, "getRequestContext").mockReturnValue(
        mockRequestCtx as any,
      );

      // Tenant A caches /pricing on a.example (same shared store/function).
      const ctxA = createMockMiddlewareContext("http://a.example/pricing");
      const nextA = vi.fn().mockResolvedValue(
        new Response("A pricing", {
          headers: { "Cache-Control": "s-maxage=60" },
        }),
      );
      const responseA = (await middleware(ctxA, nextA)) as Response;
      await vi.runAllTimersAsync();
      expect(responseA.headers.get("x-document-cache-status")).toBe("MISS");

      // Tenant B requests the identical pathname on b.example. Without host in
      // the key this store (which keys by the raw string, like
      // MemorySegmentCacheStore/VercelCacheStore) would replay A's body to B.
      // Host namespacing forces a MISS so B renders its own body.
      const ctxB = createMockMiddlewareContext("http://b.example/pricing");
      const nextB = vi.fn().mockResolvedValue(
        new Response("B pricing", {
          headers: { "Cache-Control": "s-maxage=60" },
        }),
      );
      const responseB = (await middleware(ctxB, nextB)) as Response;
      await vi.runAllTimersAsync();

      expect(nextB).toHaveBeenCalledTimes(1);
      expect(responseB.headers.get("x-document-cache-status")).toBe("MISS");
      expect(await responseB.text()).toBe("B pricing");

      // Two isolated entries, each under its own host-namespaced key.
      expect(mockStore.cache.has("a.example/pricing:html")).toBe(true);
      expect(mockStore.cache.has("b.example/pricing:html")).toBe(true);
    });

    it("still HITs a same-host, same-path request under the host-namespaced key", async () => {
      const { createDocumentCacheMiddleware } =
        await import("../document-cache.js");

      // Pre-populate under the host-namespaced default key.
      const cachedResponse = new Response("A pricing", {
        headers: { "Cache-Control": "s-maxage=60" },
      });
      mockStore.cache.set("a.example/pricing:html", {
        response: cachedResponse,
        staleAt: Date.now() + 60 * 1000,
      });

      const middleware = createDocumentCacheMiddleware();
      const ctx = createMockMiddlewareContext("http://a.example/pricing");
      const next = vi.fn();

      const originalModule = await import("../../server/request-context.js");
      vi.spyOn(originalModule, "getRequestContext").mockReturnValue(
        mockRequestCtx as any,
      );

      const response = (await middleware(ctx, next)) as Response;

      expect(next).not.toHaveBeenCalled();
      expect(response.headers.get("x-document-cache-status")).toBe("HIT");
      expect(await response.text()).toBe("A pricing");
    });
  });

  describe("debug logging", () => {
    it("should not log when debug is false", async () => {
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const { createDocumentCacheMiddleware } =
        await import("../document-cache.js");

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
      const { createDocumentCacheMiddleware } =
        await import("../document-cache.js");

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
    it("should fall through to handler on cache lookup failure", async () => {
      const { createDocumentCacheMiddleware } =
        await import("../document-cache.js");

      // Cache lookup fails before the handler runs
      vi.spyOn(mockStore, "getResponse").mockRejectedValue(
        new Error("Cache unavailable"),
      );

      const middleware = createDocumentCacheMiddleware();
      const ctx = createMockMiddlewareContext("http://localhost/page");

      const next = vi.fn().mockResolvedValue(new Response("Fallback"));

      const originalModule = await import("../../server/request-context.js");
      vi.spyOn(originalModule, "getRequestContext").mockReturnValue(
        mockRequestCtx as any,
      );

      const response = (await middleware(ctx, next)) as Response;

      // Handler called exactly once as graceful fallback
      expect(next).toHaveBeenCalledTimes(1);
      expect(await response.text()).toBe("Fallback");
    });

    it("should re-throw post-handler errors without calling next() again", async () => {
      const { createDocumentCacheMiddleware } =
        await import("../document-cache.js");

      const middleware = createDocumentCacheMiddleware();
      const ctx = createMockMiddlewareContext("http://localhost/page");

      // Handler returns a response whose body.tee() will throw
      const badResponse = new Response("ok", {
        headers: { "Cache-Control": "s-maxage=60" },
      });
      // Consume the body so .tee() throws
      await badResponse.text();

      const next = vi.fn().mockResolvedValue(badResponse);

      const originalModule = await import("../../server/request-context.js");
      vi.spyOn(originalModule, "getRequestContext").mockReturnValue(
        mockRequestCtx as any,
      );

      await expect(middleware(ctx, next)).rejects.toThrow();
      // next() was called once (the handler ran), must not be called again
      expect(next).toHaveBeenCalledTimes(1);
    });

    it("should fall through to handler when keyGenerator throws", async () => {
      const { createDocumentCacheMiddleware } =
        await import("../document-cache.js");

      const middleware = createDocumentCacheMiddleware({
        keyGenerator: () => {
          throw new Error("key generation failed");
        },
      });
      const ctx = createMockMiddlewareContext("http://localhost/page");

      const next = vi.fn().mockResolvedValue(new Response("Origin"));

      const originalModule = await import("../../server/request-context.js");
      vi.spyOn(originalModule, "getRequestContext").mockReturnValue(
        mockRequestCtx as any,
      );

      const response = (await middleware(ctx, next)) as Response;

      expect(next).toHaveBeenCalledTimes(1);
      expect(await response.text()).toBe("Origin");
    });
  });

  describe("onResponse callbacks", () => {
    it("should fire onResponse callbacks on fresh cache HIT", async () => {
      const { createDocumentCacheMiddleware } =
        await import("../document-cache.js");

      // Pre-populate cache
      const cachedResponse = new Response("Cached", {
        headers: { "Cache-Control": "s-maxage=60" },
      });
      mockStore.cache.set("localhost/page:html", {
        response: cachedResponse,
        staleAt: Date.now() + 60 * 1000,
      });

      const callback = vi.fn((r: Response) => {
        const headers = new Headers(r.headers);
        headers.set("x-custom", "from-callback");
        return new Response(r.body, { status: r.status, headers });
      });
      mockRequestCtx._onResponseCallbacks.push(callback);

      const middleware = createDocumentCacheMiddleware();
      const ctx = createMockMiddlewareContext("http://localhost/page");
      const next = vi.fn();

      const originalModule = await import("../../server/request-context.js");
      vi.spyOn(originalModule, "getRequestContext").mockReturnValue(
        mockRequestCtx as any,
      );

      const response = (await middleware(ctx, next)) as Response;

      expect(callback).toHaveBeenCalledTimes(1);
      expect(response.headers.get("x-custom")).toBe("from-callback");
      expect(response.headers.get("x-document-cache-status")).toBe("HIT");
    });

    it("should fire onResponse callbacks on stale cache HIT", async () => {
      const { createDocumentCacheMiddleware } =
        await import("../document-cache.js");

      // Pre-populate cache with stale entry
      const staleResponse = new Response("Stale", {
        headers: {
          "Cache-Control": "s-maxage=60, stale-while-revalidate=300",
        },
      });
      mockStore.cache.set("localhost/page:html", {
        response: staleResponse,
        staleAt: Date.now() - 1000,
      });

      const callback = vi.fn((r: Response) => {
        const headers = new Headers(r.headers);
        headers.set("x-custom", "stale-callback");
        return new Response(r.body, { status: r.status, headers });
      });
      mockRequestCtx._onResponseCallbacks.push(callback);

      const middleware = createDocumentCacheMiddleware();
      const ctx = createMockMiddlewareContext("http://localhost/page");
      const next = vi.fn().mockResolvedValue(
        new Response("Fresh", {
          headers: {
            "Cache-Control": "s-maxage=60, stale-while-revalidate=300",
          },
        }),
      );

      const originalModule = await import("../../server/request-context.js");
      vi.spyOn(originalModule, "getRequestContext").mockReturnValue(
        mockRequestCtx as any,
      );

      const response = (await middleware(ctx, next)) as Response;

      expect(callback).toHaveBeenCalledTimes(1);
      expect(response.headers.get("x-custom")).toBe("stale-callback");
      expect(response.headers.get("x-document-cache-status")).toBe("STALE");
    });

    it("should drain callbacks so they do not fire twice", async () => {
      const { createDocumentCacheMiddleware } =
        await import("../document-cache.js");

      // Pre-populate cache
      const cachedResponse = new Response("Cached", {
        headers: { "Cache-Control": "s-maxage=60" },
      });
      mockStore.cache.set("localhost/page:html", {
        response: cachedResponse,
        staleAt: Date.now() + 60 * 1000,
      });

      const callback = vi.fn((r: Response) => r);
      mockRequestCtx._onResponseCallbacks.push(callback);

      const middleware = createDocumentCacheMiddleware();
      const ctx = createMockMiddlewareContext("http://localhost/page");
      const next = vi.fn();

      const originalModule = await import("../../server/request-context.js");
      vi.spyOn(originalModule, "getRequestContext").mockReturnValue(
        mockRequestCtx as any,
      );

      await middleware(ctx, next);

      expect(callback).toHaveBeenCalledTimes(1);
      // Callbacks array should be drained
      expect(mockRequestCtx._onResponseCallbacks).toHaveLength(0);
    });
  });

  describe("no cache store", () => {
    it("should pass through when no cache store is configured", async () => {
      const { createDocumentCacheMiddleware } =
        await import("../document-cache.js");

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

      const response = (await middleware(ctx, next)) as Response;

      expect(next).toHaveBeenCalledTimes(1);
      expect(response.headers.has("x-document-cache-status")).toBe(false);
    });
  });
});
