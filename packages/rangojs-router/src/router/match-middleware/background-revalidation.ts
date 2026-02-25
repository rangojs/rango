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
 *   | Create fresh handleStore |  Isolate from response stream
 *   +---------------------------+
 *         |
 *         v
 *   +---------------------+
 *   | isFullMatch?        |
 *   +---------------------+
 *         |
 *   +-----+-----+
 *   |           |
 *  yes          no
 *   |           |
 *   v           v
 * resolveAll  resolveWithRevalidation
 * Segments    + resolveIntercepts
 *   |           |
 *   +-----------+
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
 * The background revalidation creates a fresh handleStore:
 *
 *   requestCtx._handleStore = createHandleStore();
 *
 * This prevents background handle.push() calls from:
 *   - Polluting the current response stream
 *   - Causing duplicate data in the client
 *   - Creating race conditions
 *
 *
 * FULL VS PARTIAL REVALIDATION
 * ============================
 *
 * Full Match (document request):
 *   - Simple resolveAllSegments()
 *   - No need to compare with previous state
 *
 * Partial Match (navigation):
 *   - resolveAllSegmentsWithRevalidation()
 *   - Also resolves intercept segments if applicable
 *   - More complex but handles all scenarios
 */
import type { ResolvedSegment } from "../../types.js";
import type { MatchContext, MatchPipelineState } from "../match-context.js";
import { getRouterContext } from "../router-context.js";
import type { GeneratorMiddleware } from "./cache-lookup.js";
import { debugLog, debugWarn } from "../logging.js";

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
      resolveAllSegmentsWithRevalidation,
      resolveAllSegments,
      resolveInterceptEntry,
    } = getRouterContext<TEnv>();

    const requestCtx = getRequestContext();
    const cacheScope = ctx.cacheScope;

    requestCtx?.waitUntil(async () => {
      debugLog("backgroundRevalidation", "revalidating stale route", {
        pathname: ctx.pathname,
        fullMatch: ctx.isFullMatch,
      });
      try {
        // Create a fresh handleStore for background revalidation
        // to avoid polluting the current response's handle stream
        if (requestCtx) {
          requestCtx._handleStore = createHandleStore();
        }

        let freshSegments: ResolvedSegment[];

        if (ctx.isFullMatch) {
          // Full match (document request) - simple resolution
          freshSegments = await resolveAllSegments(
            ctx.entries,
            ctx.routeKey,
            ctx.matched.params,
            ctx.handlerContext,
            ctx.loaderPromises,
          );
        } else {
          // Partial match (navigation) - resolution with revalidation
          const freshResult = await resolveAllSegmentsWithRevalidation(
            ctx.entries,
            ctx.routeKey,
            ctx.matched.params,
            ctx.handlerContext,
            ctx.clientSegmentSet,
            ctx.prevParams,
            ctx.request,
            ctx.prevUrl,
            ctx.url,
            ctx.loaderPromises,
            ctx.actionContext,
            ctx.interceptResult,
            ctx.localRouteName,
            ctx.pathname,
          );

          freshSegments = freshResult.segments;

          // For intercept revalidation, also resolve fresh intercept segments
          if (ctx.interceptResult) {
            const freshInterceptSegments = await resolveInterceptEntry(
              ctx.interceptResult.intercept,
              ctx.interceptResult.entry,
              ctx.matched.params,
              ctx.handlerContext,
              true,
              {
                clientSegmentIds: ctx.clientSegmentSet,
                prevParams: ctx.prevParams,
                request: ctx.request,
                prevUrl: ctx.prevUrl,
                nextUrl: ctx.url,
                routeKey: ctx.routeKey,
                actionContext: ctx.actionContext,
                stale: false,
              },
            );
            freshSegments = [...freshSegments, ...freshInterceptSegments];
          }
        }

        await cacheScope.cacheRoute(
          ctx.pathname,
          ctx.matched.params,
          freshSegments,
          ctx.isIntercept,
        );
        debugLog("backgroundRevalidation", "revalidation complete", {
          pathname: ctx.pathname,
        });
      } catch (error) {
        debugWarn("backgroundRevalidation", "revalidation failed", {
          pathname: ctx.pathname,
          error: String(error),
        });
      }
    });
  };
}
