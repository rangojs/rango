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

/** Header indicating cache status for debugging */
const CACHE_STATUS_HEADER = "x-document-cache-status";

/**
 * Simple hash function for segment IDs.
 * Creates a short, deterministic hash to differentiate cache keys
 * based on which segments the client already has.
 */
function hashSegmentIds(segmentIds: string): string {
  if (!segmentIds) return "";

  let hash = 0;
  for (let i = 0; i < segmentIds.length; i++) {
    const char = segmentIds.charCodeAt(i);
    hash = ((hash << 5) - hash + char) | 0;
  }
  // Convert to base36 for shorter string, take absolute value
  return Math.abs(hash).toString(36);
}

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
 * Add cache status header to response for debugging
 */
function addCacheStatusHeader(
  response: Response,
  status: "HIT" | "STALE" | "MISS",
): Response {
  const headers = new Headers(response.headers);
  headers.set(CACHE_STATUS_HEADER, status);

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Drain and run onResponse callbacks registered on the request context.
 * Mirrors the drain semantics of finalizeResponse() in rsc/helpers.ts:
 * callbacks are spliced out so they fire at most once per request.
 */
function drainOnResponseCallbacks(
  response: Response,
  requestCtx:
    | { _onResponseCallbacks: Array<(r: Response) => Response> }
    | undefined,
): Response {
  if (!requestCtx || requestCtx._onResponseCallbacks.length === 0) {
    return response;
  }
  const callbacks = requestCtx._onResponseCallbacks;
  requestCtx._onResponseCallbacks = [];
  let result = response;
  for (const callback of callbacks) {
    result = callback(result) ?? result;
  }
  return result;
}

// ============================================================================
// Document Cache Middleware
// ============================================================================

export interface DocumentCacheOptions<TEnv = any> {
  /**
   * Skip caching for specific paths (e.g., API routes)
   */
  skipPaths?: string[];

  /**
   * Custom cache key generator
   */
  keyGenerator?: (url: URL) => string;

  /**
   * Callback to determine if caching should be enabled for this request.
   * Receives the middleware context and returns true to enable caching.
   * If not provided, caching is enabled by default.
   *
   * @example
   * ```typescript
   * createDocumentCacheMiddleware({
   *   isEnabled: (ctx) => !ctx.request.headers.has('x-skip-cache'),
   * })
   * ```
   */
  isEnabled?: (ctx: MiddlewareContext<TEnv>) => boolean | Promise<boolean>;

  /**
   * Enable debug logging for cache operations.
   * Logs HIT, MISS, STALE, and REVALIDATED events.
   * Defaults to false.
   */
  debug?: boolean;
}

/**
 * Create document cache middleware
 *
 * Add this middleware to your router to enable document-level caching.
 * It uses the cache store's getResponse/putResponse methods for caching.
 * Routes opt-in by setting Cache-Control headers with s-maxage.
 *
 * @example
 * ```typescript
 * // Add middleware to router
 * const router = createRouter<AppEnv>()
 *   .use(createDocumentCacheMiddleware({
 *     isEnabled: (ctx) => ctx.url.pathname !== '/admin',
 *   }))
 *   .route("home", (ctx) => {
 *     ctx.headers.set("Cache-Control", "s-maxage=60, stale-while-revalidate=300");
 *     return <HomePage />;
 *   });
 * ```
 */
export function createDocumentCacheMiddleware<TEnv = any>(
  options: DocumentCacheOptions<TEnv> = {},
): MiddlewareFn<TEnv> {
  const { skipPaths = [], keyGenerator, isEnabled, debug = false } = options;

  const log = debug ? (message: string) => console.log(message) : () => {};

  return async function documentCacheMiddleware(
    ctx: MiddlewareContext<TEnv>,
    next: () => Promise<Response>,
  ): Promise<Response> {
    const url = ctx.url;

    // Skip RSC action requests (mutations shouldn't be cached)
    if (url.searchParams.has("_rsc_action")) {
      return next();
    }

    // Skip loader requests (have their own caching)
    if (url.searchParams.has("_rsc_loader")) {
      return next();
    }

    // Skip configured paths
    if (skipPaths.some((path) => url.pathname.startsWith(path))) {
      return next();
    }

    // Check if caching is enabled for this request
    if (isEnabled) {
      const enabled = await isEnabled(ctx);
      if (!enabled) {
        return next();
      }
    }

    // Get request context and cache store
    const requestCtx = getRequestContext();
    const store = requestCtx?._cacheStore;

    // Skip if no cache store or store doesn't support response caching
    if (!store?.getResponse || !store?.putResponse) {
      return next();
    }

    // Determine request type for cache key differentiation
    const isPartial = url.searchParams.has("_rsc_partial");
    const typeLabel = isPartial ? "RSC" : "HTML";

    // Generate cache key
    // For partial requests, include hash of client segments to prevent serving
    // wrong cached response when navigating from different pages with different layouts
    const clientSegments = url.searchParams.get("_rsc_segments") || "";
    const segmentHash =
      isPartial && clientSegments ? `:${hashSegmentIds(clientSegments)}` : "";
    const typeSuffix = isPartial ? ":rsc" : ":html";
    const cacheKey = keyGenerator
      ? keyGenerator(url) + segmentHash + typeSuffix
      : `${url.pathname}${segmentHash}${typeSuffix}`;

    try {
      // 1. Check cache
      const cached = await store.getResponse(cacheKey);

      if (cached && cached.response.status === 200) {
        if (!cached.shouldRevalidate) {
          // Fresh hit - return immediately
          log(`[DocumentCache] HIT ${typeLabel}: ${url.pathname}`);
          return drainOnResponseCallbacks(
            addCacheStatusHeader(cached.response, "HIT"),
            requestCtx,
          );
        }

        // Stale hit - return cached response, revalidate in background
        log(
          `[DocumentCache] STALE ${typeLabel}: ${url.pathname} (revalidating)`,
        );

        if (requestCtx) {
          requestCtx.waitUntil(async () => {
            try {
              const fresh = await next();
              const directives = shouldCacheResponse(fresh);

              if (directives) {
                await store.putResponse!(
                  cacheKey,
                  fresh,
                  directives.sMaxAge!,
                  directives.staleWhileRevalidate,
                );
                log(
                  `[DocumentCache] REVALIDATED ${typeLabel}: ${url.pathname}`,
                );
              }
            } catch (error) {
              console.error(`[DocumentCache] Revalidation failed:`, error);
            }
          });
        }

        return drainOnResponseCallbacks(
          addCacheStatusHeader(cached.response, "STALE"),
          requestCtx,
        );
      }

      // 2. Cache miss - run handler
      const originalResponse = await next();

      // 3. Cache if response has appropriate headers
      const directives = shouldCacheResponse(originalResponse);

      if (directives) {
        log(
          `[DocumentCache] MISS ${typeLabel}: ${url.pathname} (caching with s-maxage=${directives.sMaxAge})`,
        );

        // Tee the body so we can return one stream and cache the other
        const [returnStream, cacheStream] = originalResponse.body!.tee();

        // Clone response for caching (non-blocking)
        if (requestCtx) {
          requestCtx.waitUntil(async () => {
            try {
              await store.putResponse!(
                cacheKey,
                new Response(cacheStream, originalResponse),
                directives.sMaxAge!,
                directives.staleWhileRevalidate,
              );
            } catch (error) {
              console.error(`[DocumentCache] Cache write failed:`, error);
            }
          });
        }

        return addCacheStatusHeader(
          new Response(returnStream, originalResponse),
          "MISS",
        );
      }

      // No cache headers - pass through
      return originalResponse;
    } catch (error) {
      console.error(`[DocumentCache] Error:`, error);
      // On any cache error, fall through to handler
      return next();
    }
  };
}
