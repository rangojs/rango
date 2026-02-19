/**
 * Cache Lookup Middleware
 *
 * First middleware in the pipeline. Checks cache before segment resolution.
 *
 * FLOW DIAGRAM
 * ============
 *
 *   source (empty)
 *         |
 *         v
 *   +---------------------+
 *   | Is action request?  |──yes──> yield* source (pass through)
 *   +---------------------+
 *         | no
 *         v
 *   +---------------------+
 *   | Cache enabled?      |──no───> yield* source (pass through)
 *   +---------------------+
 *         | yes
 *         v
 *   +---------------------+
 *   | Lookup cache        |
 *   | (pathname, params)  |
 *   +---------------------+
 *         |
 *   +-----+-----+
 *   |           |
 *  miss        hit
 *   |           |
 *   v           v
 * yield*    Set state.cacheHit = true
 * source    Set state.shouldRevalidate
 *   |           |
 *   |           v
 *   |    +---------------------------+
 *   |    | For each cached segment:  |
 *   |    |  - Apply revalidation     |
 *   |    |  - Set component = null   |
 *   |    |    if client has it       |
 *   |    +---------------------------+
 *   |           |
 *   |           v
 *   |    +---------------------------+
 *   |    | Resolve fresh loaders     |  <-- Loaders are NEVER cached
 *   |    | (always fresh data)       |
 *   |    +---------------------------+
 *   |           |
 *   |           v
 *   |    yield cached segments
 *   |    yield fresh loader segments
 *   |           |
 *   +-----------+
 *         |
 *         v
 *      next middleware
 *
 *
 * CACHE BEHAVIOR
 * ==============
 *
 * Cache HIT:
 *   - state.cacheHit = true signals downstream middleware to skip
 *   - Cached segments have their components nullified if client already has them
 *   - Loaders are always re-resolved for fresh data
 *   - state.shouldRevalidate triggers background SWR if cache was stale
 *
 * Cache MISS:
 *   - Passes through to segment-resolution middleware
 *   - No segments yielded from this middleware
 *
 * Loaders:
 *   - NEVER cached by design
 *   - Always resolved fresh on every request
 *   - Ensures data freshness even with cached UI components
 *
 *
 * REVALIDATION RULES
 * ==================
 *
 * Each cached segment is evaluated against its revalidation rules:
 *
 *   1. No rules defined -> use default (skip if client has segment)
 *   2. Rules return false -> skip re-render (nullify component)
 *   3. Rules return true -> re-render (keep component)
 *
 * Revalidation context includes:
 *   - Previous/next URL and params
 *   - Request object
 *   - Action context (if POST)
 */
import type { ResolvedSegment } from "../../types.js";
import type { MatchContext, MatchPipelineState } from "../match-context.js";
import { getRouterContext } from "../router-context.js";
import type { PrerenderStore, PrerenderEntry } from "../../prerender/store.js";

// Lazily initialized prerender store singleton and dynamically imported deps.
// Dynamic imports prevent pulling in @vitejs/plugin-rsc/rsc virtual module at
// top-level, which breaks vitest (only URLs with file:, data:, node: schemes).
let prerenderStoreInstance: PrerenderStore | null | undefined;
let _deserializeSegments: typeof import("../../cache/cache-scope.js").deserializeSegments | undefined;
let _hashParams: typeof import("../../prerender/param-hash.js").hashParams | undefined;
let _getRequestContext: typeof import("../../server/request-context.js").getRequestContext | undefined;

async function ensurePrerenderDeps() {
  if (!_deserializeSegments) {
    const [cache, paramHash, reqCtx, store] = await Promise.all([
      import("../../cache/cache-scope.js"),
      import("../../prerender/param-hash.js"),
      import("../../server/request-context.js"),
      import("../../prerender/store.js"),
    ]);
    _deserializeSegments = cache.deserializeSegments;
    _hashParams = paramHash.hashParams;
    _getRequestContext = reqCtx.getRequestContext;
    if (prerenderStoreInstance === undefined) {
      prerenderStoreInstance = store.createPrerenderStore();
    }
  }
}

/**
 * Shared yield logic for prerender and static handler store entries.
 * Deserializes segments, replays handle data, yields segments with partial
 * navigation nullification, and resolves fresh loaders.
 */
async function* yieldFromStore<TEnv>(
  entry: PrerenderEntry,
  ctx: MatchContext<TEnv>,
  state: MatchPipelineState,
  pipelineStart: number,
): AsyncGenerator<ResolvedSegment> {
  const {
    resolveLoadersOnlyWithRevalidation,
    resolveLoadersOnly,
  } = getRouterContext<TEnv>();

  if (!_deserializeSegments || !_hashParams || !_getRequestContext) {
    throw new Error("yieldFromStore called before ensurePrerenderDeps");
  }

  const segments = await _deserializeSegments(entry.segments);

  // Replay handle data (same as runtime cache hit path)
  const handleStore = _getRequestContext()?._handleStore;
  if (handleStore) {
    for (const [segId, segHandles] of Object.entries(entry.handles)) {
      if (Object.keys(segHandles).length > 0) {
        handleStore.replaySegmentData(segId, segHandles);
      }
    }
  }

  state.cacheHit = true;
  state.cachedSegments = segments;
  state.cachedMatchedIds = segments.map((s) => s.id);

  // For partial navigation, nullify components the client already has
  // so parent layouts stay live (client keeps its existing versions).
  // When params changed (e.g., different guide slug), the segments have
  // different content, so we must NOT nullify.
  const paramsChanged = !ctx.isFullMatch &&
    JSON.stringify(ctx.matched.params) !== JSON.stringify(ctx.prevParams);
  for (const segment of segments) {
    if (!ctx.isFullMatch && !paramsChanged && ctx.clientSegmentSet.has(segment.id)) {
      segment.component = null;
      segment.loading = undefined;
    }
    yield segment;
  }

  // Resolve loaders fresh (loaders are never pre-rendered/cached)
  if (ctx.isFullMatch) {
    if (resolveLoadersOnly) {
      const loaderSegments = await ctx.Store.run(() =>
        resolveLoadersOnly(ctx.entries, ctx.handlerContext),
      );
      state.matchedIds = state.cachedMatchedIds!;
      for (const segment of loaderSegments) {
        yield segment;
      }
    } else {
      state.matchedIds = state.cachedMatchedIds!;
    }
  } else {
    if (resolveLoadersOnlyWithRevalidation) {
      const loaderResult = await ctx.Store.run(() =>
        resolveLoadersOnlyWithRevalidation(
          ctx.entries,
          ctx.handlerContext,
          ctx.clientSegmentSet,
          ctx.prevParams,
          ctx.request,
          ctx.prevUrl,
          ctx.url,
          ctx.routeKey,
          ctx.actionContext,
        ),
      );
      state.matchedIds = [
        ...state.cachedMatchedIds!,
        ...loaderResult.matchedIds,
      ];
      for (const segment of loaderResult.segments) {
        yield segment;
      }
    } else {
      state.matchedIds = state.cachedMatchedIds!;
    }
  }

  const ms = ctx.metricsStore;
  if (ms) {
    ms.metrics.push({ label: "pipeline:cache-lookup", duration: performance.now() - pipelineStart, startTime: pipelineStart - ms.requestStart });
  }
}

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
    const pipelineStart = performance.now();
    const ms = ctx.metricsStore;

    const {
      evaluateRevalidation,
      buildEntryRevalidateMap,
      resolveLoadersOnlyWithRevalidation,
      resolveLoadersOnly,
    } = getRouterContext<TEnv>();

    // Prerender lookup: check build-time cached data before runtime cache.
    // Prerender data is available regardless of runtime cache configuration.
    if (!ctx.isAction && ctx.matched.pr) {
      await ensurePrerenderDeps();
      if (prerenderStoreInstance) {
        const paramHash = _hashParams!(ctx.matched.params);

        if (ctx.isIntercept) {
          // Intercept navigation: try intercept-specific prerender entry
          const entry = await prerenderStoreInstance.get(
            ctx.matched.routeKey, paramHash + "/i", { pathname: ctx.pathname }
          );
          if (entry) {
            yield* yieldFromStore(entry, ctx, state, pipelineStart);
            return;
          }
          // No intercept prerender -- fall through to normal pipeline
          // (skip non-intercept prerender to let intercept-resolution run)
        } else {
          // Normal navigation: existing behavior
          const entry = await prerenderStoreInstance.get(
            ctx.matched.routeKey, paramHash, { pathname: ctx.pathname }
          );
          if (entry) {
            yield* yieldFromStore(entry, ctx, state, pipelineStart);
            return;
          }
        }
      }
    }

    // Dev-mode static handler interception for non-Node.js runtimes.
    // __PRERENDER_DEV_URL is set by the Vite plugin when the RSC environment
    // lacks a Node.js module runner (e.g. workerd, Deno workers). In those
    // runtimes, handlers that depend on Node APIs like node:fs can't run
    // in-process. We redirect them to the /__rsc_prerender endpoint which
    // resolves segments in a Node.js temp server, same as prerender routes.
    // In Node.js dev mode this variable is undefined -- handlers run
    // in-process where Node APIs work, so no interception is needed.
    if (!ctx.isAction && !ctx.matched.pr && globalThis.__PRERENDER_DEV_URL) {
      const hasStatic = ctx.entries.some(
        (e) => (e.type === "layout" || e.type === "route" || e.type === "parallel") && e.isStaticPrerender
      );
      if (hasStatic) {
        await ensurePrerenderDeps();
        if (prerenderStoreInstance) {
          const paramHash = _hashParams!(ctx.matched.params);

          if (ctx.isIntercept) {
            const entry = await prerenderStoreInstance.get(
              ctx.matched.routeKey, paramHash + "/i", { pathname: ctx.pathname }
            );
            if (entry) {
              yield* yieldFromStore(entry, ctx, state, pipelineStart);
              return;
            }
            // No intercept prerender -- fall through to normal pipeline
          } else {
            const entry = await prerenderStoreInstance.get(
              ctx.matched.routeKey, paramHash, { pathname: ctx.pathname }
            );
            if (entry) {
              yield* yieldFromStore(entry, ctx, state, pipelineStart);
              return;
            }
          }
        }
      }
    }

    // Skip cache during actions
    if (ctx.isAction || !ctx.cacheScope?.enabled) {
      // Cache miss - pass through to segment resolution
      yield* source;
      if (ms) {
        ms.metrics.push({ label: "pipeline:cache-lookup", duration: performance.now() - pipelineStart, startTime: pipelineStart - ms.requestStart });
      }
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
      if (ms) {
        ms.metrics.push({ label: "pipeline:cache-lookup", duration: performance.now() - pipelineStart, startTime: pipelineStart - ms.requestStart });
      }
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
        const loaderSegments = await Store.run(() =>
          resolveLoadersOnly(ctx.entries, ctx.handlerContext)
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
        const loaderResult = await Store.run(() =>
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
    if (ms) {
      ms.metrics.push({ label: "pipeline:cache-lookup", duration: performance.now() - pipelineStart, startTime: pipelineStart - ms.requestStart });
    }
  };
}
