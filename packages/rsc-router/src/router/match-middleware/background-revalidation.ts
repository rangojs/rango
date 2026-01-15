/**
 * Background Revalidation Middleware
 *
 * Triggers SWR (stale-while-revalidate) background revalidation when cache is stale.
 * Observes segments passing through without modifying them.
 */
import type { ResolvedSegment } from "../../types.js";
import type { MatchContext, MatchPipelineState } from "../match-context.js";
import { getRouterContext } from "../router-context.js";
import type { GeneratorMiddleware } from "./cache-lookup.js";

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
  state: MatchPipelineState
): GeneratorMiddleware<ResolvedSegment> {
  return async function* (
    source: AsyncGenerator<ResolvedSegment>
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

    const logPrefix = ctx.isFullMatch ? "[Router.match]" : "[Router.matchPartial]";

    requestCtx?.waitUntil(async () => {
      console.log(`${logPrefix} Revalidating stale route: ${ctx.pathname}`);
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
            ctx.loaderPromises
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
            ctx.pathname
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
              }
            );
            freshSegments = [...freshSegments, ...freshInterceptSegments];
          }
        }

        cacheScope.cacheRoute(
          ctx.pathname,
          ctx.matched.params,
          freshSegments,
          ctx.isIntercept
        );
        console.log(`${logPrefix} Revalidation complete: ${ctx.pathname}`);
      } catch (error) {
        console.error(`${logPrefix} Revalidation failed:`, error);
      }
    });
  };
}
