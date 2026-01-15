/**
 * Segment Resolution Middleware
 *
 * Resolves all segments with revalidation logic when cache misses.
 * Only runs if state.cacheHit === false.
 */
import type { ResolvedSegment } from "../../types.js";
import type { MatchContext, MatchPipelineState } from "../match-context.js";
import { getRouterContext } from "../router-context.js";
import type { GeneratorMiddleware } from "./cache-lookup.js";

/**
 * Creates segment resolution middleware
 *
 * Only runs on cache miss (state.cacheHit === false).
 * Uses resolveAllSegmentsWithRevalidation from RouterContext to resolve segments.
 */
export function withSegmentResolution<TEnv>(
  ctx: MatchContext<TEnv>,
  state: MatchPipelineState
): GeneratorMiddleware<ResolvedSegment> {
  return async function* (
    source: AsyncGenerator<ResolvedSegment>
  ): AsyncGenerator<ResolvedSegment> {
    // IMPORTANT: Always iterate source first to give cache-lookup a chance
    // to run and set state.cacheHit. Without this, cache-lookup never executes!
    for await (const segment of source) {
      yield segment;
    }

    // If cache hit, segments were already yielded by cache lookup
    if (state.cacheHit) {
      return;
    }

    const {
      getContext: getServerContext,
      resolveAllSegmentsWithRevalidation,
      resolveAllSegments,
    } = getRouterContext<TEnv>();

    const Store = ctx.Store;

    if (ctx.isFullMatch) {
      // Full match (document request) - simple resolution without revalidation
      const segments = await getServerContext().runWithStore(
        Store,
        Store.namespace || "#router",
        Store.parent,
        async () => {
          return resolveAllSegments(
            ctx.entries,
            ctx.routeKey,
            ctx.matched.params,
            ctx.handlerContext,
            ctx.loaderPromises
          );
        }
      );

      // Update state with resolved segments
      state.segments = segments;
      state.matchedIds = segments.map((s) => s.id);

      // Yield all resolved segments
      for (const segment of segments) {
        yield segment;
      }
    } else {
      // Partial match (navigation) - resolution with revalidation logic
      const result = await getServerContext().runWithStore(
        Store,
        Store.namespace || "#router",
        Store.parent,
        async () => {
          return resolveAllSegmentsWithRevalidation(
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
        }
      );

      // Update state with resolved segments
      state.segments = result.segments;
      state.matchedIds = result.matchedIds;

      // Yield all resolved segments
      for (const segment of result.segments) {
        yield segment;
      }
    }
  };
}
