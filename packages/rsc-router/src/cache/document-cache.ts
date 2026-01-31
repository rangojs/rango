/**
 * Document-Level Cache Middleware
 *
 * Caches full HTTP responses at the edge based on Cache-Control headers.
 * Routes opt-in to caching by setting s-maxage or stale-while-revalidate headers.
 *
 * Flow:
 * 1. Check cache for existing response
 * 2. If fresh hit → return cached response
 * 3. If stale hit (within SWR window) → return cached, revalidate in background
 * 4. If miss → run handler, cache if response has cache headers
 */

import type { MiddlewareFn, MiddlewareContext } from "../router/middleware.js";
import { getRequestContext } from "../server/request-context.js";

// ============================================================================
// Constants
// ============================================================================

/** Header storing timestamp when entry becomes stale */
const STALE_AT_HEADER = "x-document-cache-stale-at";

/** Header indicating cache status for debugging */
const CACHE_STATUS_HEADER = "x-document-cache-status";

// ============================================================================
// Cache Control Parsing
// ============================================================================

interface CacheDirectives {
  sMaxAge?: number;
  staleWhileRevalidate?: number;
}

/**
 * Parse Cache-Control header for s-maxage and stale-while-revalidate directives
 */
function parseCacheControl(header: string | null): CacheDirectives | null {
  if (!header) return null;

  const directives: CacheDirectives = {};

  // Parse s-maxage
  const sMaxAgeMatch = header.match(/s-maxage\s*=\s*(\d+)/i);
  if (sMaxAgeMatch) {
    directives.sMaxAge = parseInt(sMaxAgeMatch[1], 10);
  }

  // Parse stale-while-revalidate
  const swrMatch = header.match(/stale-while-revalidate\s*=\s*(\d+)/i);
  if (swrMatch) {
    directives.staleWhileRevalidate = parseInt(swrMatch[1], 10);
  }

  // Only return if we have at least s-maxage (required for document caching)
  if (directives.sMaxAge !== undefined) {
    return directives;
  }

  return null;
}

/**
 * Check if response should be cached based on Cache-Control headers
 */
function shouldCacheResponse(response: Response): CacheDirectives | null {
  // Only cache successful responses
  if (response.status !== 200) {
    return null;
  }

  const cacheControl = response.headers.get("Cache-Control");
  return parseCacheControl(cacheControl);
}

// ============================================================================
// Response Helpers
// ============================================================================

/**
 * Clone response and add stale-at header for SWR tracking
 */
function addCacheMetadata(
  response: Response,
  directives: CacheDirectives
): Response {
  const headers = new Headers(response.headers);

  // Calculate when this entry becomes stale
  const staleAt = Date.now() + (directives.sMaxAge ?? 0) * 1000;
  headers.set(STALE_AT_HEADER, String(staleAt));

  // Set extended TTL for SWR window (s-maxage + stale-while-revalidate)
  const swrWindow = directives.staleWhileRevalidate ?? 0;
  const totalTtl = (directives.sMaxAge ?? 0) + swrWindow;
  headers.set("Cache-Control", `public, max-age=${totalTtl}`);

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Add cache status header to response for debugging
 */
function addCacheStatusHeader(
  response: Response,
  status: "HIT" | "STALE" | "MISS"
): Response {
  const headers = new Headers(response.headers);
  headers.set(CACHE_STATUS_HEADER, status);

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

// ============================================================================
// Document Cache Middleware
// ============================================================================

export interface DocumentCacheOptions {
  /**
   * Skip caching for specific paths (e.g., API routes)
   */
  skipPaths?: string[];

  /**
   * Custom cache key generator
   */
  keyGenerator?: (url: URL) => string;
}

/**
 * Create document cache middleware
 *
 * Add this as the first middleware in your router to enable document-level caching.
 * Routes opt-in by setting Cache-Control headers with s-maxage.
 *
 * @example
 * ```typescript
 * const router = createRSCRouter({
 *   // ... routes
 * }).use(createDocumentCacheMiddleware());
 *
 * // In your route handler, opt-in to caching:
 * route("home", (ctx) => {
 *   ctx.header("Cache-Control", "s-maxage=60, stale-while-revalidate=300");
 *   return <HomePage />;
 * });
 * ```
 */
export function createDocumentCacheMiddleware<TEnv = any>(
  options: DocumentCacheOptions = {}
): MiddlewareFn<TEnv> {
  const { skipPaths = [], keyGenerator } = options;

  return async function documentCacheMiddleware(
    ctx: MiddlewareContext<TEnv>,
    next: () => Promise<Response>
  ): Promise<Response> {
    const url = ctx.url;

    // Skip partial requests (client-side navigation uses segment cache)
    if (url.searchParams.has("_rsc_partial")) {
      return next();
    }

    // Skip RSC action requests
    if (url.searchParams.has("_rsc_action")) {
      return next();
    }

    // Skip loader requests
    if (url.searchParams.has("_rsc_loader")) {
      return next();
    }

    // Skip configured paths
    if (skipPaths.some((path) => url.pathname.startsWith(path))) {
      return next();
    }

    // Get cache instance
    const cache = caches.default;

    // Generate cache key - use a fake URL since CF Cache API requires Request
    const cacheKeyUrl = keyGenerator
      ? keyGenerator(url)
      : `https://document-cache.internal/${url.pathname}${url.search}`;
    const cacheKey = new Request(cacheKeyUrl);

    // Get request context for waitUntil
    const requestCtx = getRequestContext();

    try {
      // 1. Check cache
      const cached = await cache.match(cacheKey);

      if (cached) {
        const staleAt = Number(cached.headers.get(STALE_AT_HEADER) || 0);
        const isStale = staleAt > 0 && Date.now() > staleAt;

        if (!isStale) {
          // Fresh hit - return immediately
          console.log(`[DocumentCache] HIT: ${url.pathname}`);
          return addCacheStatusHeader(cached, "HIT");
        }

        // Stale hit - return cached response, revalidate in background
        console.log(`[DocumentCache] STALE: ${url.pathname} (revalidating)`);

        if (requestCtx) {
          requestCtx.waitUntil(async () => {
            try {
              const fresh = await next();
              const directives = shouldCacheResponse(fresh);

              if (directives) {
                const toCache = addCacheMetadata(fresh.clone(), directives);
                await cache.put(cacheKey, toCache);
                console.log(`[DocumentCache] REVALIDATED: ${url.pathname}`);
              }
            } catch (error) {
              console.error(`[DocumentCache] Revalidation failed:`, error);
            }
          });
        }

        return addCacheStatusHeader(cached, "STALE");
      }

      // 2. Cache miss - run handler
      const response = await next();

      // 3. Cache if response has appropriate headers
      const directives = shouldCacheResponse(response);

      if (directives) {
        console.log(
          `[DocumentCache] MISS: ${url.pathname} (caching with s-maxage=${directives.sMaxAge})`
        );

        // Clone response for caching (non-blocking)
        if (requestCtx) {
          requestCtx.waitUntil(async () => {
            try {
              const toCache = addCacheMetadata(response.clone(), directives);
              await cache.put(cacheKey, toCache);
            } catch (error) {
              console.error(`[DocumentCache] Cache write failed:`, error);
            }
          });
        }

        return addCacheStatusHeader(response, "MISS");
      }

      // No cache headers - pass through
      return response;
    } catch (error) {
      console.error(`[DocumentCache] Error:`, error);
      // On any cache error, fall through to handler
      return next();
    }
  };
}
