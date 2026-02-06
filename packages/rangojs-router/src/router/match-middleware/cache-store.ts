/**
 * Cache Store Middleware
 *
 * Stores resolved segments in cache for future requests.
 * Implements proactive caching for partial navigation scenarios.
 *
 * FLOW DIAGRAM
 * ============
 *
 *   source (from intercept-resolution)
 *         |
 *         v
 *   +---------------------------+
 *   | Collect + yield all      |  Observer pattern: pass through
 *   | allSegments[]            |
 *   +---------------------------+
 *         |
 *         v
 *   +---------------------+
 *   | Should skip cache?  |
 *   | - !cacheScope       |──yes──> return
 *   | - isAction          |
 *   | - cacheHit          |
 *   | - method !== GET    |
 *   +---------------------+
 *         | no
 *         v
 *   +-------------------------------+
 *   | Any null components?          |
 *   | (client already has segment)  |
 *   +-------------------------------+
 *         |
 *   +-----+-----+
 *   |           |
 *  yes          no
 *   |           |
 *   v           v
 * PROACTIVE   DIRECT
 * CACHE       CACHE
 *   |           |
 *   v           v
 * waitUntil()  cacheRoute()
 * re-render    immediately
 * fresh        |
 *   |           |
 *   +-----------+
 *         |
 *         v
 *      next middleware
 *
 *
 * CACHING STRATEGIES
 * ==================
 *
 * 1. Direct Cache (all components present):
 *    - Immediate cacheRoute() call
 *    - All segments have valid components
 *    - Used for fresh full-page renders
 *
 * 2. Proactive Cache (null components present):
 *    - Background re-render via waitUntil()
 *    - Creates fresh context to avoid polluting response
 *    - Re-resolves ALL segments without revalidation
 *    - Ensures cache has complete components for future requests
 *
 *
 * WHY PROACTIVE CACHING?
 * ======================
 *
 * During partial navigation, some segments have null components:
 *
 *   Request: /products/123 -> /products/456
 *   Segments: [ProductLayout(null), ProductPage(component)]
 *
 * The null means "client already has this, don't re-send."
 * But if we cache these null components, future document requests
 * would fail (no component to render).
 *
 * Solution: Background re-render all segments fresh, then cache.
 * This ensures the cache always has complete, renderable segments.
 *
 *
 * PROACTIVE CACHE FLOW
 * ====================
 *
 *   1. Current request returns (fast, with nulls)
 *   2. waitUntil() triggers background work
 *   3. Create fresh handler context (silent, no stream pollution)
 *   4. Re-resolve all entries without revalidation logic
 *   5. Also resolve intercept segments if applicable
 *   6. Store complete segments in cache
 *
 *
 * SKIP CONDITIONS
 * ===============
 *
 * Caching is skipped when:
 *   - Cache scope disabled (no caching configured)
 *   - This is an action request (mutations shouldn't cache)
 *   - Cache was already hit (no need to re-cache same data)
 *   - Non-GET request (only GET requests are cacheable)
 */
import type { ResolvedSegment } from "../../types.js";
import { getRequestContext } from "../../server/request-context.js";
import type { MatchContext, MatchPipelineState } from "../match-context.js";
import { getRouterContext } from "../router-context.js";
import type { GeneratorMiddleware } from "./cache-lookup.js";

/**
 * Creates cache store middleware
 *
 * Observes all segments passing through and stores them in cache after pipeline completes.
 * Handles proactive caching for null-component segments.
 */
export function withCacheStore<TEnv>(
  ctx: MatchContext<TEnv>,
  state: MatchPipelineState,
): GeneratorMiddleware<ResolvedSegment> {
  return async function* (
    source: AsyncGenerator<ResolvedSegment>,
  ): AsyncGenerator<ResolvedSegment> {
    // Collect all segments while passing them through
    const allSegments: ResolvedSegment[] = [];
    for await (const segment of source) {
      allSegments.push(segment);
      yield segment;
    }

    // Skip caching if:
    // 1. Cache miss but cache scope is disabled
    // 2. This is an action (actions don't cache)
    // 3. Cache was already hit (no need to re-cache)
    // 4. Non-GET request (only cache GET requests)
    if (
      !ctx.cacheScope?.enabled ||
      ctx.isAction ||
      state.cacheHit ||
      ctx.request.method !== "GET"
    ) {
      return;
    }

    const {
      createHandlerContext,
      setupLoaderAccessSilent,
      resolveAllSegments,
      resolveInterceptEntry,
    } = getRouterContext<TEnv>();

    // Combine main segments with intercept segments
    const allSegmentsToCache = [...allSegments, ...state.interceptSegments];

    // Check if any non-loader segments have null components
    // This happens when client already had those segments (partial navigation)
    const hasNullComponents = allSegmentsToCache.some(
      (s) => s.component === null && s.type !== "loader",
    );

    const requestCtx = getRequestContext();
    if (!requestCtx) return;

    const cacheScope = ctx.cacheScope;

    // Register onResponse callback to skip caching for non-200 responses
    // Note: error/notFound status codes are set elsewhere (not caching-specific)
    requestCtx.onResponse((response) => {
      // Only cache successful responses
      if (response.status !== 200) {
        console.log(
          `[CacheStore] Skipping cache: non-200 status ${response.status} for ${ctx.pathname}`,
        );
        return response;
      }

      if (hasNullComponents) {
        // Proactive caching: render all segments fresh in background
        // This ensures cache has complete components for future requests
        requestCtx.waitUntil(async () => {
          console.log(
            `[Router.matchPartial] Proactive caching: ${ctx.pathname} (rendering null-component segments)`,
          );
          try {
            // Create fresh context for proactive caching
            // This prevents handle data from polluting the response stream
            const proactiveHandlerContext = createHandlerContext(
              ctx.matched.params,
              ctx.request,
              ctx.url.searchParams,
              ctx.pathname,
              ctx.url,
              ctx.bindings,
              ctx.routeMap,
              ctx.matched.routeKey
            );
            const proactiveLoaderPromises = new Map<string, Promise<any>>();

            // Set up loader access that ignores handle pushes
            setupLoaderAccessSilent(
              proactiveHandlerContext,
              proactiveLoaderPromises,
            );

            // Re-resolve ALL segments without revalidation
            const Store = ctx.Store;
            const freshSegments = await Store.run(() =>
              resolveAllSegments(
                ctx.entries,
                ctx.routeKey,
                ctx.matched.params,
                proactiveHandlerContext,
                proactiveLoaderPromises,
              ),
            );

            // Also resolve intercept segments fresh if applicable
            let freshInterceptSegments: ResolvedSegment[] = [];
            if (ctx.interceptResult) {
              freshInterceptSegments = await Store.run(() =>
                resolveInterceptEntry(
                  ctx.interceptResult!.intercept,
                  ctx.interceptResult!.entry,
                  ctx.matched.params,
                  proactiveHandlerContext,
                  true, // belongsToRoute
                  // No revalidationContext = render fresh
                ),
              );
            }

            const completeSegments = [
              ...freshSegments,
              ...freshInterceptSegments,
            ];
            await cacheScope.cacheRoute(
              ctx.pathname,
              ctx.matched.params,
              completeSegments,
              ctx.isIntercept,
            );
            console.log(
              `[Router.matchPartial] Proactive caching complete: ${ctx.pathname}`,
            );
          } catch (error) {
            console.error(
              `[Router.matchPartial] Proactive caching failed:`,
              error,
            );
          }
        });
      } else {
        // All segments have components - cache directly
        // Schedule caching in waitUntil since cacheRoute is now async (key resolution)
        requestCtx.waitUntil(async () => {
          await cacheScope.cacheRoute(
            ctx.pathname,
            ctx.matched.params,
            allSegmentsToCache,
            ctx.isIntercept,
          );
        });
      }

      return response;
    });
  };
}
