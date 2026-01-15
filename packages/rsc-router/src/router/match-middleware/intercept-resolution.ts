/**
 * Intercept Resolution Middleware
 *
 * Resolves intercept (modal slot) segments for soft navigation.
 * Yields intercept segments after main route segments.
 *
 * FLOW DIAGRAM
 * ============
 *
 *   source (from segment-resolution)
 *         |
 *         v
 *   +---------------------------+
 *   | Collect + yield source   |  Pass through main segments
 *   | segments[]               |
 *   +---------------------------+
 *         |
 *         v
 *   +---------------------+
 *   | isFullMatch?        |──yes──> return (no intercepts on doc requests)
 *   +---------------------+
 *         | no
 *         v
 *   +---------------------+
 *   | Has interceptResult |──no───> return
 *   | AND not cached?     |
 *   +---------------------+
 *         | yes
 *         v
 *   +----------------------+    +----------------------------+
 *   | Fresh intercept?     |yes>| resolveInterceptEntry()    |
 *   | (!cacheHit or        |    | - middleware, loaders, UI  |
 *   |  no intercept segs)  |    +----------------------------+
 *   +----------------------+              |
 *         | no                            v
 *         v                    yield intercept segments
 *   +----------------------------+        |
 *   | Cache hit with intercept   |        |
 *   | handleCacheHitIntercept()  |        |
 *   | - Extract from cache       |        |
 *   | - Re-resolve loaders only  |        |
 *   +----------------------------+        |
 *         |                               |
 *         +-------------------------------+
 *         |
 *         v
 *   +---------------------------+
 *   | Update state:             |
 *   |  - interceptSegments      |
 *   |  - slots[slotName]        |
 *   +---------------------------+
 *         |
 *         v
 *      next middleware
 *
 *
 * INTERCEPT SCENARIOS
 * ===================
 *
 * 1. Fresh intercept (no cache):
 *    - Full resolution of intercept entry
 *    - Resolves middleware, loaders, and component
 *    - Yields all intercept segments
 *
 * 2. Cache hit with intercept:
 *    - Extracts intercept segments from cached data
 *    - Re-resolves ONLY loaders for fresh data
 *    - Keeps cached component/layout
 *
 * 3. No intercept:
 *    - Passes through unchanged
 *    - No intercept segments yielded
 *
 *
 * WHAT ARE INTERCEPTS?
 * ====================
 *
 * Intercepts enable "soft navigation" patterns like modals:
 *
 *   1. User clicks a link (e.g., /photos/123)
 *   2. Instead of full navigation, content renders in a modal slot
 *   3. Background page remains visible and interactive
 *   4. Hard navigation (direct URL) shows full page
 *
 * Configuration:
 *   intercept("@modal", "photos", <PhotoModal />, () => [...])
 *
 * The intercept resolves to segments that render in the named slot
 * instead of replacing the main content.
 *
 *
 * SLOT STRUCTURE
 * ==============
 *
 * state.slots[slotName] = {
 *   active: true,
 *   segments: [...intercept segments]
 * }
 *
 * The client uses this to:
 *   1. Keep current page segments
 *   2. Render intercept segments in named <Outlet name="@modal" />
 */
import type { ResolvedSegment } from "../../types.js";
import type { MatchContext, MatchPipelineState } from "../match-context.js";
import { getRouterContext } from "../router-context.js";
import type { GeneratorMiddleware } from "./cache-lookup.js";

/**
 * Creates intercept resolution middleware
 *
 * If ctx.interceptResult exists and we're not in a cache-hit-with-intercept scenario:
 * - Resolves intercept segments
 * - Updates state.interceptSegments
 * - Updates state.slots with the intercept slot
 * - Yields intercept segments after main segments
 */
export function withInterceptResolution<TEnv>(
  ctx: MatchContext<TEnv>,
  state: MatchPipelineState
): GeneratorMiddleware<ResolvedSegment> {
  return async function* (
    source: AsyncGenerator<ResolvedSegment>
  ): AsyncGenerator<ResolvedSegment> {
    // First, yield all segments from the source (main segment resolution or cache)
    const segments: ResolvedSegment[] = [];
    for await (const segment of source) {
      segments.push(segment);
      yield segment;
    }

    // Skip intercept resolution for full match (document requests don't have intercepts)
    if (ctx.isFullMatch) {
      return;
    }

    // Skip intercept resolution if:
    // 1. No intercept result
    // 2. Already have intercept segments (from cache hit with intercept key)
    // 3. Cache hit with intercept key
    const skipInterceptResolution =
      !ctx.interceptResult ||
      state.interceptSegments.length > 0 ||
      (state.cacheHit && ctx.isIntercept);

    if (skipInterceptResolution) {
      // For cache hit with intercept, extract intercept segments from cached data for slots
      // and re-resolve loaders for fresh data
      if (ctx.interceptResult && state.cacheHit && ctx.isIntercept) {
        await handleCacheHitIntercept(ctx, state, segments);
      }
      return;
    }

    // Resolve intercept segments
    const {
      getContext: getServerContext,
      resolveInterceptEntry,
    } = getRouterContext<TEnv>();

    const slotName = ctx.interceptResult!.intercept.slotName;
    console.log(
      `[Router.matchPartial] Found intercept for "${ctx.localRouteName}" -> slot "${slotName}"`
    );

    // Resolve intercept entry (middleware, loaders, handler)
    const Store = ctx.Store;
    const interceptSegments = await getServerContext().runWithStore(
      Store,
      Store.namespace || "#router",
      Store.parent,
      () =>
        resolveInterceptEntry(
          ctx.interceptResult!.intercept,
          ctx.interceptResult!.entry,
          ctx.matched.params,
          ctx.handlerContext,
          true, // belongsToRoute
          {
            clientSegmentIds: ctx.clientSegmentSet,
            prevParams: ctx.prevParams,
            request: ctx.request,
            prevUrl: ctx.prevUrl,
            nextUrl: ctx.url,
            routeKey: ctx.routeKey,
            actionContext: ctx.actionContext,
            stale: ctx.stale,
          }
        )
    );

    // Update state
    state.interceptSegments = interceptSegments;
    state.slots[slotName] = {
      active: true,
      segments: interceptSegments,
    };

    // Yield intercept segments
    for (const segment of interceptSegments) {
      yield segment;
    }
  };
}

/**
 * Handle cache hit with intercept scenario
 *
 * Extract intercept segments from cached data and re-resolve loaders for fresh data.
 */
async function handleCacheHitIntercept<TEnv>(
  ctx: MatchContext<TEnv>,
  state: MatchPipelineState,
  segments: ResolvedSegment[]
): Promise<void> {
  if (!ctx.interceptResult) return;

  const {
    getContext: getServerContext,
    resolveInterceptLoadersOnly,
  } = getRouterContext<TEnv>();

  const slotName = ctx.interceptResult.intercept.slotName;

  // Find intercept segments from cached segments (namespace starts with "intercept:")
  const interceptSegments = segments.filter((s) =>
    s.namespace?.startsWith("intercept:")
  );
  state.interceptSegments = interceptSegments;

  // Re-resolve intercept loaders for fresh data on cache hit
  // This keeps cached component/layout but fetches fresh loader data
  if (resolveInterceptLoadersOnly) {
    const Store = ctx.Store;
    const freshLoaderResult = await getServerContext().runWithStore(
      Store,
      Store.namespace || "#router",
      Store.parent,
      () =>
        resolveInterceptLoadersOnly(
          ctx.interceptResult!.intercept,
          ctx.interceptResult!.entry,
          ctx.matched.params,
          ctx.handlerContext,
          true, // belongsToRoute
          {
            clientSegmentIds: ctx.clientSegmentSet,
            prevParams: ctx.prevParams,
            request: ctx.request,
            prevUrl: ctx.prevUrl,
            nextUrl: ctx.url,
            routeKey: ctx.routeKey,
            actionContext: ctx.actionContext,
            stale: ctx.stale,
          }
        )
    );

    // Update intercept segment's loaderDataPromise with fresh data
    if (freshLoaderResult) {
      const interceptMainSegment = interceptSegments.find(
        (s) => s.type === "parallel" && s.slot
      );
      if (interceptMainSegment) {
        interceptMainSegment.loaderDataPromise = freshLoaderResult.loaderDataPromise;
        interceptMainSegment.loaderIds = freshLoaderResult.loaderIds;
        console.log(
          `[Router.matchPartial] Cache HIT + fresh loaders for intercept "${ctx.localRouteName}" -> slot "${slotName}"`
        );
      }
    } else {
      console.log(
        `[Router.matchPartial] Cache HIT for intercept "${ctx.localRouteName}" -> slot "${slotName}" (no loader revalidation)`
      );
    }
  }

  state.slots[slotName] = {
    active: true,
    segments: interceptSegments,
  };
}
