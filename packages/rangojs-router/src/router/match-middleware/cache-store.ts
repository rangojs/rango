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
import { debugLog, debugWarn, getOrCreateRequestId } from "../logging.js";
import { INTERNAL_RANGO_DEBUG } from "../../internal-debug.js";
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
    const ms = ctx.metricsStore;

    // Collect all segments while passing them through
    const allSegments: ResolvedSegment[] = [];
    for await (const segment of source) {
      allSegments.push(segment);
      yield segment;
    }

    // Measure own work only (after source iteration completes)
    const ownStart = performance.now();

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
      if (ms) {
        ms.metrics.push({
          label: "pipeline:cache-store",
          duration: performance.now() - ownStart,
          startTime: ownStart - ms.requestStart,
        });
      }
      return;
    }

    const {
      createHandlerContext,
      setupLoaderAccess,
      resolveAllSegments,
      resolveInterceptEntry,
      createHandleStore,
    } = getRouterContext<TEnv>();

    // Combine main segments with intercept segments
    const allSegmentsToCache = [...allSegments, ...state.interceptSegments];

    // Check if any non-loader segments have null components from revalidation
    // skip (client already had them). Segments where the handler intentionally
    // returned null are not revalidation skips — re-rendering them will still
    // produce null, so proactive caching would be wasted work.
    const clientIdSet = new Set(ctx.clientSegmentIds);
    const hasNullComponents = allSegmentsToCache.some(
      (s) =>
        s.component === null && s.type !== "loader" && clientIdSet.has(s.id),
    );

    const requestCtx = getRequestContext();
    if (!requestCtx) return;

    const cacheScope = ctx.cacheScope;
    const reqId = INTERNAL_RANGO_DEBUG
      ? getOrCreateRequestId(ctx.request)
      : undefined;

    // Register onResponse callback to skip caching for non-200 responses
    // Note: error/notFound status codes are set elsewhere (not caching-specific)
    requestCtx.onResponse((response) => {
      // Only cache successful responses
      if (response.status !== 200) {
        debugLog("cacheStore", "skipping cache for non-200 response", {
          status: response.status,
          pathname: ctx.pathname,
        });
        return response;
      }

      if (hasNullComponents) {
        // Proactive caching: render all segments fresh in background
        // This ensures cache has complete components for future requests
        requestCtx.waitUntil(async () => {
          // Prevent background metrics from polluting foreground timeline.
          const savedMetrics = ctx.Store.metrics;
          ctx.Store.metrics = undefined;

          const start = performance.now();
          debugLog("cacheStore", "proactive caching started", {
            pathname: ctx.pathname,
          });
          // Swap to a fresh HandleStore so handle.push() calls from
          // proactive resolution are captured (not silenced). The original
          // store's stream is already sent by waitUntil time.
          // cacheRoute reads from requestCtx._handleStore, so this ensures
          // complete handle data (e.g. breadcrumbs) is cached.
          const originalHandleStore = requestCtx._handleStore;
          requestCtx._handleStore = createHandleStore();
          try {
            // Create fresh context for proactive caching
            const proactiveHandlerContext = createHandlerContext(
              ctx.matched.params,
              ctx.request,
              ctx.url.searchParams,
              ctx.pathname,
              ctx.url,
              ctx.env,
              ctx.routeMap,
              ctx.matched.routeKey,
              ctx.matched.responseType,
              ctx.matched.pt === true,
            );
            const proactiveLoaderPromises = new Map<string, Promise<any>>();

            // Use normal loader access so handle data is captured
            setupLoaderAccess(proactiveHandlerContext, proactiveLoaderPromises);

            // Re-resolve ALL segments without revalidation.
            // Skip DSL loaders — they are never cached (cacheRoute filters them)
            // and are always resolved fresh on each request.
            const Store = ctx.Store;
            const freshSegments = await Store.run(() =>
              resolveAllSegments(
                ctx.entries,
                ctx.routeKey,
                ctx.matched.params,
                proactiveHandlerContext,
                proactiveLoaderPromises,
                { skipLoaders: true },
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
            requestCtx._handleStore.seal();
            await cacheScope.cacheRoute(
              ctx.pathname,
              ctx.matched.params,
              completeSegments,
              ctx.isIntercept,
            );
            if (INTERNAL_RANGO_DEBUG) {
              const dur = performance.now() - start;
              console.log(
                `[RSC Background][req:${reqId}] Proactive cache ${ctx.pathname} (${dur.toFixed(2)}ms) segments=${completeSegments.length}`,
              );
            }
            debugLog("cacheStore", "proactive caching complete", {
              pathname: ctx.pathname,
            });
          } catch (error) {
            if (INTERNAL_RANGO_DEBUG) {
              const dur = performance.now() - start;
              console.log(
                `[RSC Background][req:${reqId}] Proactive cache ${ctx.pathname} FAILED (${dur.toFixed(2)}ms) error=${String(error)}`,
              );
            }
            debugWarn("cacheStore", "proactive caching failed", {
              pathname: ctx.pathname,
              error: String(error),
            });
          } finally {
            requestCtx._handleStore = originalHandleStore;
            ctx.Store.metrics = savedMetrics;
          }
        });
      } else {
        // All segments have components - cache directly
        // Schedule caching in waitUntil since cacheRoute is now async (key resolution)
        requestCtx.waitUntil(async () => {
          const start = performance.now();
          await cacheScope.cacheRoute(
            ctx.pathname,
            ctx.matched.params,
            allSegmentsToCache,
            ctx.isIntercept,
          );
          if (INTERNAL_RANGO_DEBUG) {
            const dur = performance.now() - start;
            console.log(
              `[RSC Background][req:${reqId}] Cache store ${ctx.pathname} (${dur.toFixed(2)}ms) segments=${allSegmentsToCache.length}`,
            );
          }
        });
      }

      return response;
    });

    if (ms) {
      ms.metrics.push({
        label: "pipeline:cache-store",
        duration: performance.now() - ownStart,
        startTime: ownStart - ms.requestStart,
      });
    }
  };
}
