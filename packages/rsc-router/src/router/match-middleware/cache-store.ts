/**
 * Cache Store Middleware
 *
 * Stores resolved segments in cache for future requests.
 * Handles proactive caching when segments have null components.
 */
import type { ResolvedSegment } from "../../types.js";
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
  state: MatchPipelineState
): GeneratorMiddleware<ResolvedSegment> {
  return async function* (
    source: AsyncGenerator<ResolvedSegment>
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
    if (!ctx.cacheScope?.enabled || ctx.isAction || state.cacheHit) {
      return;
    }

    const {
      getContext: getServerContext,
      createHandlerContext,
      setupLoaderAccessSilent,
      resolveAllSegments,
      resolveInterceptEntry,
      getRequestContext,
    } = getRouterContext<TEnv>();

    // Combine main segments with intercept segments
    const allSegmentsToCache = [...allSegments, ...state.interceptSegments];

    // Check if any non-loader segments have null components
    // This happens when client already had those segments (partial navigation)
    const hasNullComponents = allSegmentsToCache.some(
      (s) => s.component === null && s.type !== "loader"
    );

    if (hasNullComponents) {
      // Proactive caching: render all segments fresh in background
      // This ensures cache has complete components for future requests
      const requestCtx = getRequestContext();
      const cacheScope = ctx.cacheScope;

      requestCtx?.waitUntil(async () => {
        console.log(
          `[Router.matchPartial] Proactive caching: ${ctx.pathname} (rendering null-component segments)`
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
            ctx.bindings
          );
          const proactiveLoaderPromises = new Map<string, Promise<any>>();

          // Set up loader access that ignores handle pushes
          setupLoaderAccessSilent(proactiveHandlerContext, proactiveLoaderPromises);

          // Re-resolve ALL segments without revalidation
          const Store = ctx.Store;
          const freshSegments = await getServerContext().runWithStore(
            Store,
            Store.namespace || "#router",
            Store.parent,
            () =>
              resolveAllSegments(
                ctx.entries,
                ctx.routeKey,
                ctx.matched.params,
                proactiveHandlerContext,
                proactiveLoaderPromises
              )
          );

          // Also resolve intercept segments fresh if applicable
          let freshInterceptSegments: ResolvedSegment[] = [];
          if (ctx.interceptResult) {
            freshInterceptSegments = await getServerContext().runWithStore(
              Store,
              Store.namespace || "#router",
              Store.parent,
              () =>
                resolveInterceptEntry(
                  ctx.interceptResult!.intercept,
                  ctx.interceptResult!.entry,
                  ctx.matched.params,
                  proactiveHandlerContext,
                  true // belongsToRoute
                  // No revalidationContext = render fresh
                )
            );
          }

          const completeSegments = [...freshSegments, ...freshInterceptSegments];
          cacheScope.cacheRoute(
            ctx.pathname,
            ctx.matched.params,
            completeSegments,
            ctx.isIntercept
          );
          console.log(
            `[Router.matchPartial] Proactive caching complete: ${ctx.pathname}`
          );
        } catch (error) {
          console.error(`[Router.matchPartial] Proactive caching failed:`, error);
        }
      });
    } else {
      // All segments have components - cache directly
      ctx.cacheScope.cacheRoute(
        ctx.pathname,
        ctx.matched.params,
        allSegmentsToCache,
        ctx.isIntercept
      );
    }
  };
}
