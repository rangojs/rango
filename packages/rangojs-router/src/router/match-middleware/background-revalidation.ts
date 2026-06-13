/**
 * Background Revalidation Middleware
 *
 * Implements SWR (stale-while-revalidate) pattern.
 * Triggers background refresh when cached data is stale.
 *
 * FLOW DIAGRAM
 * ============
 *
 *   source (from cache-store)
 *         |
 *         v
 *   +---------------------------+
 *   | yield* source            |  Pure pass-through
 *   | (no modifications)       |
 *   +---------------------------+
 *         |
 *         v
 *   +---------------------+
 *   | Should revalidate?  |
 *   | - shouldRevalidate  |──no───> return
 *   | - cacheHit          |
 *   | - cacheScope        |
 *   +---------------------+
 *         | yes
 *         v
 *   +---------------------------+
 *   | requestCtx.waitUntil()   |  Non-blocking background task
 *   +---------------------------+
 *         |
 *         v (async, doesn't block response)
 *   +---------------------------+
 *   | Create fresh context     |  Fresh handleStore, handlerContext,
 *   | (full isolation)         |  and loaderPromises map
 *   +---------------------------+
 *         |
 *         v
 *   +---------------------------+
 *   | resolveAllSegments()    |  Fresh resolution (no revalidation)
 *   | + resolveIntercepts()   |  Ensures complete components
 *   +---------------------------+
 *         |
 *         v
 *   +---------------------------+
 *   | cacheScope.cacheRoute()  |  Update cache with fresh data
 *   +---------------------------+
 *
 *
 * SWR PATTERN
 * ===========
 *
 * Stale-While-Revalidate provides fast responses with eventual consistency:
 *
 *   Timeline:
 *   ---------
 *   T0: Request arrives
 *   T1: Cache lookup finds stale entry
 *   T2: Return stale data immediately (fast!)
 *   T3: Response sent to client
 *   T4: waitUntil() triggers background revalidation
 *   T5: Fresh data resolved
 *   T6: Cache updated with fresh data
 *   T7: Next request gets fresh data from cache
 *
 * Benefits:
 *   - Fast initial response (cached data)
 *   - Eventually consistent (background refresh)
 *   - No blocking on revalidation
 *
 *
 * WHEN IS CACHE STALE?
 * ====================
 *
 * The cache-lookup middleware sets state.shouldRevalidate based on:
 *   - TTL (time-to-live) expiration
 *   - Cache entry metadata
 *   - Configured staleness rules
 *
 * This middleware only acts on the flag, it doesn't determine staleness.
 *
 *
 * ISOLATION FROM RESPONSE
 * =======================
 *
 * Background revalidation creates fully isolated context:
 *   - Fresh handleStore (prevents polluting the response stream)
 *   - Fresh handlerContext + loaderPromises (prevents reusing memoized
 *     loader results from the foreground pass)
 *   - handleStore is saved/restored in try/finally
 *
 * This matches the proactive caching pattern in cache-store.ts.
 *
 *
 * FRESH RESOLUTION (NO REVALIDATION)
 * ===================================
 *
 * Both full and partial requests use resolveAllSegments() (without
 * revalidation logic) to ensure all segments have complete components.
 * Using revalidation-aware resolution would produce null components
 * for skipped segments, which would corrupt the cache entry.
 */
import type { ResolvedSegment } from "../../types.js";
import type { MatchContext, MatchPipelineState } from "../match-context.js";
import { getRouterContext } from "../router-context.js";
import type { GeneratorMiddleware } from "./cache-lookup.js";
import { debugLog, debugWarn, getOrCreateRequestId } from "../logging.js";
import { INTERNAL_RANGO_DEBUG } from "../../internal-debug.js";

/**
 * Creates background revalidation middleware
 *
 * If cache was stale (state.shouldRevalidate === true):
 * - Triggers background resolution via waitUntil
 * - Observes segments but doesn't modify them
 * - Updates cache with fresh segments after revalidation completes
 */
export function withBackgroundRevalidation<TEnv>(
  ctx: MatchContext<TEnv>,
  state: MatchPipelineState,
): GeneratorMiddleware<ResolvedSegment> {
  return async function* (
    source: AsyncGenerator<ResolvedSegment>,
  ): AsyncGenerator<ResolvedSegment> {
    // Pass through all segments unchanged
    for await (const segment of source) {
      yield segment;
    }

    // Only trigger background revalidation if:
    // 1. Cache was hit and stale
    // 2. Cache scope exists
    if (!state.shouldRevalidate || !state.cacheHit || !ctx.cacheScope) {
      return;
    }

    const {
      getRequestContext,
      createHandleStore,
      createHandlerContext,
      setupLoaderAccess,
      resolveAllSegments,
      resolveInterceptEntry,
    } = getRouterContext<TEnv>();

    const requestCtx = getRequestContext();
    const cacheScope = ctx.cacheScope;
    const reqId = INTERNAL_RANGO_DEBUG
      ? getOrCreateRequestId(ctx.request)
      : undefined;

    requestCtx?.waitUntil(async () => {
      // Prevent background metrics from polluting foreground timeline.
      // The foreground uses its own metricsStore reference directly (via
      // appendMetric), so nulling Store.metrics only affects track() calls
      // inside this background Store.run() scope.
      const savedMetrics = ctx.Store.metrics;
      ctx.Store.metrics = undefined;

      const start = performance.now();
      debugLog("backgroundRevalidation", "revalidating stale route", {
        pathname: ctx.pathname,
        fullMatch: ctx.isFullMatch,
      });

      // Save and replace handleStore to avoid polluting the response stream.
      // Restore in finally (same pattern as proactive caching in cache-store).
      const originalHandleStore = requestCtx._handleStore;
      requestCtx._handleStore = createHandleStore();

      try {
        const freshHandlerContext = createHandlerContext(
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
        const freshLoaderPromises = new Map<string, Promise<any>>();
        setupLoaderAccess(freshHandlerContext, freshLoaderPromises);

        const freshSegments = await ctx.Store.run(() =>
          resolveAllSegments(
            ctx.entries,
            ctx.routeKey,
            ctx.matched.params,
            freshHandlerContext,
            freshLoaderPromises,
            { skipLoaders: true },
          ),
        );

        let freshInterceptSegments: ResolvedSegment[] = [];
        if (ctx.interceptResult) {
          freshInterceptSegments = await ctx.Store.run(() =>
            resolveInterceptEntry(
              ctx.interceptResult!.intercept,
              ctx.interceptResult!.entry,
              ctx.matched.params,
              freshHandlerContext,
              true,
            ),
          );
        }

        const completeSegments = [...freshSegments, ...freshInterceptSegments];
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
            `[RSC Background][req:${reqId}] SWR revalidation ${ctx.pathname} (${dur.toFixed(2)}ms) segments=${completeSegments.length}`,
          );
        }
        debugLog("backgroundRevalidation", "revalidation complete", {
          pathname: ctx.pathname,
        });
      } catch (error) {
        if (INTERNAL_RANGO_DEBUG) {
          const dur = performance.now() - start;
          console.log(
            `[RSC Background][req:${reqId}] SWR revalidation ${ctx.pathname} FAILED (${dur.toFixed(2)}ms) error=${String(error)}`,
          );
        }
        debugWarn("backgroundRevalidation", "revalidation failed", {
          pathname: ctx.pathname,
          error: String(error),
        });
      } finally {
        requestCtx._handleStore = originalHandleStore;
        ctx.Store.metrics = savedMetrics;
      }
    });
  };
}
