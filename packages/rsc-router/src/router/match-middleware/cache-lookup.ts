/**
 * Cache Lookup Middleware
 *
 * Checks cache for segments before resolution.
 * If cache hit:
 * - Applies revalidation to determine which segments need re-rendering
 * - Resolves loaders fresh (loaders are NOT cached)
 * - Sets state.cacheHit = true
 * - Sets state.shouldRevalidate if SWR needed
 * - Yields cached segments + fresh loaders
 *
 * If cache miss:
 * - Passes through to next middleware (segment resolution)
 */
import type { ResolvedSegment } from "../../types.js";
import type { MatchContext, MatchPipelineState } from "../match-context.js";
import { getRouterContext } from "../router-context.js";

/**
 * Async generator middleware type
 */
export type GeneratorMiddleware<T> = (
  source: AsyncGenerator<T>
) => AsyncGenerator<T>;

/**
 * Creates cache lookup middleware
 *
 * Checks cache for segments. If cache hit:
 * - Applies revalidation to determine which segments need re-rendering
 * - Resolves loaders fresh (loaders are NOT cached by design)
 * - Sets state.cacheHit = true
 * - Sets state.shouldRevalidate if SWR needed
 * - Yields cached segments + fresh loader segments
 *
 * If cache miss:
 * - Passes through to next middleware
 */
export function withCacheLookup<TEnv>(
  ctx: MatchContext<TEnv>,
  state: MatchPipelineState
): GeneratorMiddleware<ResolvedSegment> {
  return async function* (
    source: AsyncGenerator<ResolvedSegment>
  ): AsyncGenerator<ResolvedSegment> {
    const {
      evaluateRevalidation,
      buildEntryRevalidateMap,
      resolveLoadersOnlyWithRevalidation,
      resolveLoadersOnly,
      getContext: getServerContext,
    } = getRouterContext<TEnv>();

    // Skip cache during actions
    if (ctx.isAction || !ctx.cacheScope?.enabled) {
      // Cache miss - pass through to segment resolution
      yield* source;
      return;
    }

    // Lookup cache
    const cacheResult = await ctx.cacheScope.lookupRoute(
      ctx.pathname,
      ctx.matched.params,
      ctx.isIntercept
    );

    if (!cacheResult) {
      // Cache miss - pass through to segment resolution
      yield* source;
      return;
    }

    // Cache HIT
    state.cacheHit = true;
    state.shouldRevalidate = cacheResult.shouldRevalidate;
    state.cachedSegments = cacheResult.segments;
    state.cachedMatchedIds = cacheResult.segments.map((s) => s.id);

    // Apply revalidation to cached segments
    const entryRevalidateMap = buildEntryRevalidateMap?.(ctx.entries);

    for (const segment of cacheResult.segments) {
      // Skip segments client doesn't have - they need their component
      if (!ctx.clientSegmentSet.has(segment.id)) {
        yield segment;
        continue;
      }

      // Skip intercept segments - they're handled separately
      if (segment.namespace?.startsWith("intercept:")) {
        yield segment;
        continue;
      }

      // Look up revalidation rules for this segment
      const entryInfo = entryRevalidateMap?.get(segment.id);
      if (!entryInfo || entryInfo.revalidate.length === 0) {
        // No revalidation rules, use default behavior (skip if client has)
        segment.component = null;
        segment.loading = undefined;
        yield segment;
        continue;
      }

      // Evaluate revalidation rules
      const shouldRevalidate = await evaluateRevalidation({
        segment,
        prevParams: ctx.prevParams,
        getPrevSegment: null,
        request: ctx.request,
        prevUrl: ctx.prevUrl,
        nextUrl: ctx.url,
        revalidations: entryInfo.revalidate.map((fn, i) => ({
          name: `revalidate${i}`,
          fn,
        })),
        routeKey: ctx.routeKey,
        context: ctx.handlerContext,
        actionContext: ctx.actionContext,
      });

      if (!shouldRevalidate) {
        // Client has it, no revalidation needed
        segment.component = null;
        segment.loading = undefined;
      }

      yield segment;
    }

    // Resolve loaders fresh (loaders are NOT cached by default)
    // This ensures fresh data even on cache hit
    const Store = ctx.Store;

    if (ctx.isFullMatch) {
      // Full match (document request) - simple loader resolution without revalidation
      if (resolveLoadersOnly) {
        const loaderSegments = await getServerContext().runWithStore(
          Store,
          Store.namespace || "#router",
          Store.parent,
          () => resolveLoadersOnly(ctx.entries, ctx.handlerContext)
        );

        // Update state - full match doesn't track matchedIds separately
        state.matchedIds = state.cachedMatchedIds!;

        // Yield fresh loader segments
        for (const segment of loaderSegments) {
          yield segment;
        }
      } else {
        state.matchedIds = state.cachedMatchedIds!;
      }
    } else {
      // Partial match (navigation) - loader resolution with revalidation
      if (resolveLoadersOnlyWithRevalidation) {
        const loaderResult = await getServerContext().runWithStore(
          Store,
          Store.namespace || "#router",
          Store.parent,
          () =>
            resolveLoadersOnlyWithRevalidation(
              ctx.entries,
              ctx.handlerContext,
              ctx.clientSegmentSet,
              ctx.prevParams,
              ctx.request,
              ctx.prevUrl,
              ctx.url,
              ctx.routeKey,
              ctx.actionContext
            )
        );

        // Update state with fresh loader matchedIds
        state.matchedIds = [
          ...state.cachedMatchedIds!,
          ...loaderResult.matchedIds,
        ];

        // Yield fresh loader segments
        for (const segment of loaderResult.segments) {
          yield segment;
        }
      } else {
        state.matchedIds = state.cachedMatchedIds!;
      }
    }
  };
}
