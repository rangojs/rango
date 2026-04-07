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
 *   - NEVER cached in the segment cache
 *   - Always resolved fresh on every request
 *   - Ensures data freshness even with cached UI components
 *   - Segment cache staleness does NOT propagate to loader revalidation;
 *     loaders use their own revalidation rules (actionId, user-defined)
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
import { resolveSink, safeEmit } from "../telemetry.js";
import { pushRevalidationTraceEntry, isTraceActive } from "../logging.js";
import { treeHasStreaming } from "./segment-resolution.js";
import type { PrerenderStore, PrerenderEntry } from "../../prerender/store.js";
import type { HandleStore } from "../../server/handle-store.js";
import {
  getRequestContext,
  _getRequestContext,
} from "../../server/request-context.js";

// Lazily initialized prerender store singleton and dynamically imported deps.
// Dynamic imports prevent pulling in @vitejs/plugin-rsc/rsc virtual module at
// top-level, which breaks vitest (only URLs with file:, data:, node: schemes).
let prerenderStoreInstance: PrerenderStore | null | undefined;
let _deserializeSegments:
  | typeof import("../../cache/segment-codec.js").deserializeSegments
  | undefined;
let _restoreHandles:
  | typeof import("../../cache/handle-snapshot.js").restoreHandles
  | undefined;
let _hashParams:
  | typeof import("../../prerender/param-hash.js").hashParams
  | undefined;
let _lazyGetRequestContext:
  | typeof import("../../server/request-context.js").getRequestContext
  | undefined;

function paramsEqual(
  a: Record<string, string>,
  b: Record<string, string>,
): boolean {
  if (a === b) return true;

  const keysA = Object.keys(a);
  if (keysA.length !== Object.keys(b).length) return false;

  for (const key of keysA) {
    if (a[key] !== b[key]) return false;
  }

  return true;
}

async function ensurePrerenderDeps() {
  if (!_deserializeSegments) {
    const [codec, snapshot, paramHash, reqCtx, store] = await Promise.all([
      import("../../cache/segment-codec.js"),
      import("../../cache/handle-snapshot.js"),
      import("../../prerender/param-hash.js"),
      import("../../server/request-context.js"),
      import("../../prerender/store.js"),
    ]);
    _deserializeSegments = codec.deserializeSegments;
    _restoreHandles = snapshot.restoreHandles;
    _hashParams = paramHash.hashParams;
    _lazyGetRequestContext = reqCtx.getRequestContext;
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
  handleStoreRef?: HandleStore,
): AsyncGenerator<ResolvedSegment> {
  const { resolveLoadersOnlyWithRevalidation, resolveLoadersOnly } =
    getRouterContext<TEnv>();

  if (
    !_deserializeSegments ||
    !_restoreHandles ||
    !_hashParams ||
    !_lazyGetRequestContext
  ) {
    throw new Error("yieldFromStore called before ensurePrerenderDeps");
  }

  const segments = await _deserializeSegments(entry.segments);

  // Replay handle data (same as runtime cache hit path).
  // Prefer the eagerly-captured handleStoreRef to avoid ALS disruption in workerd.
  const handleStore = handleStoreRef ?? _lazyGetRequestContext()?._handleStore;
  if (handleStore) {
    _restoreHandles(entry.handles, handleStore);
  }

  state.cacheHit = true;
  state.cacheSource = "prerender";
  state.cachedSegments = segments;
  state.cachedMatchedIds = segments.map((s) => s.id);

  // Set streaming flag (once) and resolve render barrier.
  const reqCtx = handleStoreRef ? undefined : _lazyGetRequestContext?.();
  const barrierReqCtx = reqCtx ?? _getRequestContext();
  if (barrierReqCtx) {
    if (barrierReqCtx._treeHasStreaming === undefined) {
      barrierReqCtx._treeHasStreaming = treeHasStreaming(ctx.entries);
    }
    barrierReqCtx._resolveRenderBarrier(segments);
  }

  // For partial navigation, nullify components the client already has
  // so parent layouts stay live (client keeps its existing versions).
  // When params changed (e.g., different guide slug), the segments have
  // different content, so we must NOT nullify.
  const paramsChanged =
    !ctx.isFullMatch && !paramsEqual(ctx.matched.params, ctx.prevParams);
  for (const segment of segments) {
    if (
      !ctx.isFullMatch &&
      !paramsChanged &&
      ctx.clientSegmentSet.has(segment.id)
    ) {
      segment.component = null;
      segment.loading = undefined;
    }
    yield segment;
  }

  // Resolve loaders fresh (loaders are never pre-rendered/cached)
  const ms = ctx.metricsStore;
  const loaderStart = performance.now();

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
          ctx.stale || undefined,
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

  if (ms) {
    const loaderEnd = performance.now();
    ms.metrics.push({
      label: "pipeline:loader-resolve",
      duration: loaderEnd - loaderStart,
      startTime: loaderStart - ms.requestStart,
      depth: 1,
    });
    ms.metrics.push({
      label: "pipeline:cache-hit",
      duration: loaderEnd - pipelineStart,
      startTime: pipelineStart - ms.requestStart,
    });
  }
}

/**
 * Async generator middleware type
 */
export type GeneratorMiddleware<T> = (
  source: AsyncGenerator<T>,
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
  state: MatchPipelineState,
): GeneratorMiddleware<ResolvedSegment> {
  return async function* (
    source: AsyncGenerator<ResolvedSegment>,
  ): AsyncGenerator<ResolvedSegment> {
    const pipelineStart = performance.now();
    const ms = ctx.metricsStore;

    // Eagerly capture the HandleStore before any async operations.
    // In workerd/Cloudflare, dynamic imports and fetch() inside the pipeline
    // can disrupt AsyncLocalStorage, causing getRequestContext() to return
    // undefined afterward. Capturing the reference early ensures handle replay
    // and handler handle-push work regardless of ALS state.
    const handleStoreRef = _getRequestContext()?._handleStore;

    const {
      evaluateRevalidation,
      buildEntryRevalidateMap,
      resolveLoadersOnlyWithRevalidation,
      resolveLoadersOnly,
    } = getRouterContext<TEnv>();

    // Prerender lookup: check build-time cached data before runtime cache.
    // Prerender data is available regardless of runtime cache configuration.
    // Skip for HMR requests — the dev prerender endpoint reads from a stale
    // RouterRegistry snapshot; rendering fresh ensures edits are visible.
    const isHmr = !!ctx.request.headers.get("X-RSC-HMR");
    if (!ctx.isAction && !isHmr && ctx.matched.pr) {
      await ensurePrerenderDeps();
      if (prerenderStoreInstance) {
        const paramHash = _hashParams!(ctx.matched.params);
        const isPassthroughPrerenderRoute = ctx.entries.some(
          (entry) => entry.type === "route" && entry.isPassthrough === true,
        );

        if (ctx.isIntercept) {
          // Intercept navigation: try intercept-specific prerender entry
          const entry = await prerenderStoreInstance.get(
            ctx.matched.routeKey,
            paramHash + "/i",
            {
              pathname: ctx.pathname,
              isPassthroughRoute: isPassthroughPrerenderRoute,
            },
          );
          if (entry) {
            yield* yieldFromStore(
              entry,
              ctx,
              state,
              pipelineStart,
              handleStoreRef,
            );
            return;
          }
          // No intercept prerender -- fall through to normal pipeline
          // (skip non-intercept prerender to let intercept-resolution run)
        } else {
          // Normal navigation: existing behavior
          const entry = await prerenderStoreInstance.get(
            ctx.matched.routeKey,
            paramHash,
            {
              pathname: ctx.pathname,
              isPassthroughRoute: isPassthroughPrerenderRoute,
            },
          );
          if (entry) {
            yield* yieldFromStore(
              entry,
              ctx,
              state,
              pipelineStart,
              handleStoreRef,
            );
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
        (e) =>
          (e.type === "layout" ||
            e.type === "route" ||
            e.type === "parallel") &&
          e.isStaticPrerender,
      );
      if (hasStatic) {
        await ensurePrerenderDeps();
        if (prerenderStoreInstance) {
          const paramHash = _hashParams!(ctx.matched.params);
          const isPassthroughPrerenderRoute = ctx.entries.some(
            (entry) => entry.type === "route" && entry.isPassthrough === true,
          );

          if (ctx.isIntercept) {
            const entry = await prerenderStoreInstance.get(
              ctx.matched.routeKey,
              paramHash + "/i",
              {
                pathname: ctx.pathname,
                isPassthroughRoute: isPassthroughPrerenderRoute,
              },
            );
            if (entry) {
              yield* yieldFromStore(
                entry,
                ctx,
                state,
                pipelineStart,
                handleStoreRef,
              );
              return;
            }
            // No intercept prerender -- fall through to normal pipeline
          } else {
            const entry = await prerenderStoreInstance.get(
              ctx.matched.routeKey,
              paramHash,
              {
                pathname: ctx.pathname,
                isPassthroughRoute: isPassthroughPrerenderRoute,
              },
            );
            if (entry) {
              yield* yieldFromStore(
                entry,
                ctx,
                state,
                pipelineStart,
                handleStoreRef,
              );
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
        ms.metrics.push({
          label: "pipeline:cache-miss",
          duration: performance.now() - pipelineStart,
          startTime: pipelineStart - ms.requestStart,
        });
      }
      return;
    }

    // Lookup cache
    const cacheResult = await ctx.cacheScope.lookupRoute(
      ctx.pathname,
      ctx.matched.params,
      ctx.isIntercept,
    );

    if (!cacheResult) {
      // Cache miss - pass through to segment resolution
      yield* source;
      if (ms) {
        ms.metrics.push({
          label: "pipeline:cache-miss",
          duration: performance.now() - pipelineStart,
          startTime: pipelineStart - ms.requestStart,
        });
      }
      return;
    }

    // Cache HIT
    state.cacheHit = true;
    state.cacheSource = "runtime";
    state.shouldRevalidate = cacheResult.shouldRevalidate;
    state.cachedSegments = cacheResult.segments;
    state.cachedMatchedIds = cacheResult.segments.map((s) => s.id);

    // Apply revalidation to cached segments.
    // For full matches or empty client segment sets, this map is unnecessary:
    // we never run segment-level revalidation and can stream segments directly.
    const canCheckSegmentRevalidation =
      !ctx.isFullMatch &&
      ctx.clientSegmentSet.size > 0 &&
      !!buildEntryRevalidateMap;
    const entryRevalidateMap = canCheckSegmentRevalidation
      ? buildEntryRevalidateMap(ctx.entries)
      : undefined;

    for (const segment of cacheResult.segments) {
      // Skip segments client doesn't have - they need their component
      if (!ctx.clientSegmentSet.has(segment.id)) {
        if (isTraceActive()) {
          pushRevalidationTraceEntry({
            segmentId: segment.id,
            segmentType: segment.type,
            belongsToRoute: segment.belongsToRoute ?? false,
            source: "cache-hit",
            defaultShouldRevalidate: true,
            finalShouldRevalidate: true,
            reason: "new-segment",
          });
        }
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

      // Even without explicit revalidation rules, route segments and their
      // children must re-render when params or search params change — the
      // handler reads ctx.params/ctx.searchParams so different values produce
      // different content. Matches evaluateRevalidation's default logic.
      const searchChanged = ctx.prevUrl.search !== ctx.url.search;
      const routeParamsChanged = !paramsEqual(
        ctx.matched.params,
        ctx.prevParams,
      );
      const shouldDefaultRevalidate =
        (searchChanged || routeParamsChanged) &&
        (segment.type === "route" ||
          (segment.belongsToRoute &&
            (segment.type === "layout" || segment.type === "parallel")));

      if (!entryInfo || entryInfo.revalidate.length === 0) {
        if (shouldDefaultRevalidate) {
          // Params or search params changed — must re-render even without custom rules
          if (isTraceActive()) {
            pushRevalidationTraceEntry({
              segmentId: segment.id,
              segmentType: segment.type,
              belongsToRoute: segment.belongsToRoute ?? false,
              source: "cache-hit",
              defaultShouldRevalidate: true,
              finalShouldRevalidate: true,
              reason: routeParamsChanged
                ? "cached-params-changed"
                : "cached-search-changed",
            });
          }
          yield segment;
          continue;
        }
        // No revalidation rules, use default behavior (skip if client has)
        if (isTraceActive()) {
          pushRevalidationTraceEntry({
            segmentId: segment.id,
            segmentType: segment.type,
            belongsToRoute: segment.belongsToRoute ?? false,
            source: "cache-hit",
            defaultShouldRevalidate: false,
            finalShouldRevalidate: false,
            reason: "cached-no-rules",
          });
        }
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
        stale: cacheResult.shouldRevalidate || ctx.stale || undefined,
        traceSource: "cache-hit",
      });

      const routerCtx = getRouterContext<TEnv>();
      if (routerCtx.telemetry) {
        const tSink = resolveSink(routerCtx.telemetry);
        safeEmit(tSink, {
          type: "revalidation.decision",
          timestamp: performance.now(),
          requestId: routerCtx.requestId,
          segmentId: segment.id,
          pathname: ctx.pathname,
          routeKey: ctx.routeKey,
          shouldRevalidate,
        });
      }

      if (!shouldRevalidate) {
        // Client has it, no revalidation needed
        segment.component = null;
        segment.loading = undefined;
      }

      yield segment;
    }

    // Set streaming flag (once) and resolve render barrier.
    const barrierReqCtx = _getRequestContext();
    if (barrierReqCtx) {
      if (barrierReqCtx._treeHasStreaming === undefined) {
        barrierReqCtx._treeHasStreaming = treeHasStreaming(ctx.entries);
      }
      barrierReqCtx._resolveRenderBarrier(cacheResult.segments);
    }

    // Resolve loaders fresh (loaders are NOT cached by default)
    // This ensures fresh data even on cache hit
    const Store = ctx.Store;
    const loaderStart = performance.now();

    if (ctx.isFullMatch) {
      // Full match (document request) - simple loader resolution without revalidation
      if (resolveLoadersOnly) {
        const loaderSegments = await Store.run(() =>
          resolveLoadersOnly(ctx.entries, ctx.handlerContext),
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
            ctx.actionContext,
            // Loaders are never cached in the segment cache, so segment
            // staleness (cacheResult.shouldRevalidate) must not propagate.
            // But browser-sent staleness (ctx.stale) — indicating an action
            // happened in this or another tab — must still reach loaders.
            ctx.stale || undefined,
          ),
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
      const loaderEnd = performance.now();
      ms.metrics.push({
        label: "pipeline:loader-resolve",
        duration: loaderEnd - loaderStart,
        startTime: loaderStart - ms.requestStart,
        depth: 1,
      });
      ms.metrics.push({
        label: "pipeline:cache-hit",
        duration: loaderEnd - pipelineStart,
        startTime: pipelineStart - ms.requestStart,
      });
    }
  };
}
