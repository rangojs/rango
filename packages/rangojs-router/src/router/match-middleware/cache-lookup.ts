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
import type { EntryData } from "../../server/context.js";
import type { MatchContext, MatchPipelineState } from "../match-context.js";
import { getRouterContext, type RouterContext } from "../router-context.js";
import { observeEvent } from "../instrument.js";
import { pushRevalidationTraceEntry, isTraceActive } from "../logging.js";
import { treeHasStreaming } from "./segment-resolution.js";
import type { PrerenderStore, PrerenderEntry } from "../../prerender/store.js";
import {
  _getRequestContext,
  type RequestContext,
} from "../../server/request-context.js";
import { createShellImplicitDocScope } from "../../cache/cache-scope.js";
import { prerenderStoreShortCircuits } from "../navigation-snapshot.js";
import { paramsEqual } from "../params-util.js";
import { recordCacheScopeDiagnostic } from "../diagnostics/channel.js";

function recordPrerenderCacheHit<TEnv>(ctx: MatchContext<TEnv>): void {
  const leafEntry = ctx.entries.at(-1);
  recordCacheScopeDiagnostic(
    {
      kind: "prerender",
      ownerType: leafEntry?.type ?? null,
      outcome: "prerendered",
      source: "prerender",
      storeKind: "prerender-store",
      ttl: null,
      swr: null,
      freshForMs: null,
      tags: [],
      identityDigest: null,
      backgroundRevalidationClaimed: false,
    },
    leafEntry?.id,
  );
}

// Lazily initialized prerender store singleton and dynamically imported deps.
// Dynamic imports prevent pulling in @vitejs/plugin-rsc/rsc virtual module at
// top-level, which breaks vitest (only URLs with file:, data:, node: schemes).
let prerenderStoreInstance: PrerenderStore | null | undefined;
let _deserializeSegments:
  | typeof import("../../cache/segment-codec.js").deserializeSegments
  | undefined;
let _fragmentSegments:
  | typeof import("../../cache/segment-codec.js").fragmentSegments
  | undefined;
let _restoreHandles:
  | typeof import("../../cache/handle-snapshot.js").restoreHandles
  | undefined;
let _decodeHandles:
  | typeof import("../../cache/handle-snapshot.js").decodeHandles
  | undefined;
let _hashParams:
  | typeof import("../../prerender/param-hash.js").hashParams
  | undefined;

async function ensurePrerenderDeps() {
  if (!_deserializeSegments) {
    const [codec, snapshot, paramHash, store] = await Promise.all([
      import("../../cache/segment-codec.js"),
      import("../../cache/handle-snapshot.js"),
      import("../../prerender/param-hash.js"),
      import("../../prerender/store.js"),
    ]);
    _deserializeSegments = codec.deserializeSegments;
    _fragmentSegments = codec.fragmentSegments;
    _restoreHandles = snapshot.restoreHandles;
    _decodeHandles = snapshot.decodeHandles;
    _hashParams = paramHash.hashParams;
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
// Resolve loaders fresh on a cache hit (loaders are NEVER cached) and yield
// the loader segments, updating state.matchedIds and pushing the loader-resolve
// + cache-hit metrics. Shared verbatim by the prerender-store path
// (yieldFromStore) and the runtime cache-hit path (withCacheLookup). The router
// resolve fns are passed in (captured early by the callers) rather than re-read
// from getRouterContext() here, because that is ALS-backed and the callers run
// awaits before reaching this point (workerd can disrupt ALS mid-pipeline).
async function* resolveFreshLoadersAndYield<TEnv>(
  ctx: MatchContext<TEnv>,
  state: MatchPipelineState,
  pipelineStart: number,
  ms: MatchContext<TEnv>["metricsStore"],
  resolveLoadersOnly: RouterContext<TEnv>["resolveLoadersOnly"],
  resolveLoadersOnlyWithRevalidation: RouterContext<TEnv>["resolveLoadersOnlyWithRevalidation"],
): AsyncGenerator<ResolvedSegment> {
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
          // Loaders are never cached in the segment cache, so segment staleness
          // must not propagate; browser-sent staleness (ctx.stale) still must.
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

async function* yieldFromStore<TEnv>(
  entry: PrerenderEntry,
  ctx: MatchContext<TEnv>,
  state: MatchPipelineState,
  pipelineStart: number,
  reqCtx: RequestContext<TEnv> | undefined,
  resolveLoadersOnly: RouterContext<TEnv>["resolveLoadersOnly"],
  resolveLoadersOnlyWithRevalidation: RouterContext<TEnv>["resolveLoadersOnlyWithRevalidation"],
): AsyncGenerator<ResolvedSegment> {
  if (
    !_deserializeSegments ||
    !_fragmentSegments ||
    !_restoreHandles ||
    !_decodeHandles ||
    !_hashParams
  ) {
    throw new Error("yieldFromStore called before ensurePrerenderDeps");
  }

  // Shell-HIT tail (issue #700): a Prerender+ppr route's tail serves from THIS
  // store (the prerender lookup runs before the cache scope), so the fragment
  // splice must apply here too — otherwise producer B entries re-serialize the
  // whole tree per request while producer A entries do not.
  const segments = reqCtx?._shellFragmentPayload
    ? await _fragmentSegments(entry.segments)
    : await _deserializeSegments(entry.segments);

  // Replay handle data (same as runtime cache hit path). entry.handles is a
  // Flight-encoded string ("" when none) — decode before restore so
  // Promise/ReactNode handle values are revived, not the corrupted JSON form.
  const handleStore = reqCtx?._handleStore;
  if (handleStore && entry.handles) {
    const handlesRecord = await _decodeHandles(entry.handles);
    if (handlesRecord) {
      _restoreHandles(handlesRecord, handleStore);
    }
  }

  state.cacheHit = true;
  state.cacheSource = "prerender";
  state.cachedSegments = segments;
  state.cachedMatchedIds = segments.map((s) => s.id);

  // Set streaming flag (once) and resolve render barrier.
  // Post-match serve-source truth for the PPR replay reporter. This overwrites
  // `intercept` because the prerender store is the response source.
  if (reqCtx) {
    reqCtx._pprReplayPostMatchReason = "prerender-store";
    if (reqCtx._treeHasStreaming === undefined) {
      reqCtx._treeHasStreaming = treeHasStreaming(ctx.entries);
    }
    reqCtx._resolveRenderBarrier(segments);
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

  // Resolve loaders fresh (loaders are never pre-rendered/cached).
  yield* resolveFreshLoadersAndYield(
    ctx,
    state,
    pipelineStart,
    ctx.metricsStore,
    resolveLoadersOnly,
    resolveLoadersOnlyWithRevalidation,
  );
}

/**
 * Whether the prerender store holds a baked entry for this route + params.
 * Consulted by the PPR replay gate (matchPartialWithPprReplay), which must
 * only report `prerender-store` when the short-circuit below will actually
 * serve: a Passthrough(Prerender()) route with an unbaked/passthrough param
 * misses the store and renders live, and replay — including its heal
 * capture — must stay available for it (withCacheStore records the doc
 * record on that path; state.cacheSource is not "prerender"). The store
 * memoizes per routeKey/paramHash, so this probe and tryPrerenderLookup's
 * subsequent get() share one underlying load.
 */
export async function prerenderEntryExists(
  routeKey: string | undefined,
  params: Record<string, string>,
  pathname: string,
  entries: EntryData[],
): Promise<boolean> {
  if (!routeKey) return false;
  // Deliberately NOT ensurePrerenderDeps(): the probe needs only the store
  // and the param hasher — pulling segment-codec here would drag the
  // @vitejs/plugin-rsc virtual module onto a path that never deserializes.
  if (!_hashParams) {
    _hashParams = (await import("../../prerender/param-hash.js")).hashParams;
  }
  if (prerenderStoreInstance === undefined) {
    prerenderStoreInstance = (
      await import("../../prerender/store.js")
    ).createPrerenderStore();
  }
  if (!prerenderStoreInstance) return false;
  // Non-intercept variant only: whether the navigation IS an intercept (and
  // therefore whether tryPrerenderLookup reads `paramHash + "/i"`) resolves
  // during the match, so this pre-match fast path can only guess the normal
  // artifact. A wrong guess is reclassified post-match from the match
  // pipeline's `_pprReplayPostMatchReason` stamp.
  const entry = await prerenderStoreInstance.get(
    routeKey,
    _hashParams!(params),
    {
      pathname,
      isPassthroughRoute: entries.some(
        (entry) => entry.type === "route" && entry.isPassthrough === true,
      ),
    },
  );
  return entry != null;
}

/**
 * Look up a prerendered (build-time cached) entry for the current route and, on
 * a hit, yield its segments. Returns true when an entry was served (the caller
 * should stop the pipeline) and false on a miss. Intercept navigations consult
 * only the intercept-specific entry (`paramHash + "/i"`); a miss there falls
 * through to the normal pipeline so intercept-resolution can run. Callers must
 * guard on `prerenderStoreInstance` after `ensurePrerenderDeps()`.
 */
async function* tryPrerenderLookup<TEnv>(
  ctx: MatchContext<TEnv>,
  state: MatchPipelineState,
  pipelineStart: number,
  reqCtx: RequestContext<TEnv> | undefined,
  resolveLoadersOnly: RouterContext<TEnv>["resolveLoadersOnly"],
  resolveLoadersOnlyWithRevalidation: RouterContext<TEnv>["resolveLoadersOnlyWithRevalidation"],
): AsyncGenerator<ResolvedSegment, boolean> {
  const paramHash = _hashParams!(ctx.matched.params);
  const isPassthroughPrerenderRoute = ctx.entries.some(
    (entry) => entry.type === "route" && entry.isPassthrough === true,
  );
  const lookupHash = ctx.isIntercept ? paramHash + "/i" : paramHash;
  const entry = await prerenderStoreInstance!.get(
    ctx.matched.routeKey,
    lookupHash,
    {
      pathname: ctx.pathname,
      isPassthroughRoute: isPassthroughPrerenderRoute,
    },
  );
  if (!entry) return false;
  yield* yieldFromStore(
    entry,
    ctx,
    state,
    pipelineStart,
    reqCtx,
    resolveLoadersOnly,
    resolveLoadersOnlyWithRevalidation,
  );
  return true;
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
    const pipelineReqCtx = _getRequestContext<TEnv>();
    // Only the match can determine interception; the source header proves
    // nothing in either direction. Clear a stale reason on normal matches.
    if (pipelineReqCtx) {
      pipelineReqCtx._pprReplayPostMatchReason = ctx.isIntercept
        ? "intercept"
        : undefined;
    }

    const {
      evaluateRevalidation,
      buildEntryRevalidateMap,
      resolveLoadersOnlyWithRevalidation,
      resolveLoadersOnly,
    } = getRouterContext<TEnv>();

    if (
      !ctx.isAction &&
      prerenderStoreShortCircuits(ctx.matched.pr, ctx.request)
    ) {
      await ensurePrerenderDeps();
      if (prerenderStoreInstance) {
        const served = yield* tryPrerenderLookup(
          ctx,
          state,
          pipelineStart,
          pipelineReqCtx,
          resolveLoadersOnly,
          resolveLoadersOnlyWithRevalidation,
        );
        if (served) {
          recordPrerenderCacheHit(ctx);
          return;
        }
      }
    }

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
          const served = yield* tryPrerenderLookup(
            ctx,
            state,
            pipelineStart,
            pipelineReqCtx,
            resolveLoadersOnly,
            resolveLoadersOnlyWithRevalidation,
          );
          if (served) {
            recordPrerenderCacheHit(ctx);
            return;
          }
        }
      }
    }

    if (ctx.isAction || !ctx.cacheScope?.enabled) {
      ctx.cacheScope?.recordDiagnosticBypass(
        ctx.isAction ? "action" : "disabled",
      );
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

    const explicitLookup = await ctx.cacheScope.lookupRouteDetailed(
      ctx.pathname,
      ctx.matched.params,
      ctx.isIntercept,
    );
    let cacheResult =
      explicitLookup.status === "hit" ? explicitLookup.result : null;

    // PPR navigation replay composed with a route-derived cache() scope. The
    // explicit tier stays authoritative: its hit serves under its own
    // key/ttl/swr semantics and reports `explicit-cache-hit` — never a false
    // replay HIT. ONLY a true `miss` lets the seeded doc record supply the
    // match (the marker's onHit observer then reports the true HIT). The
    // other outcomes render fresh: `bypass` (cache(false), a false
    // condition() — absolute opt-outs even when the pre-read gate saw a
    // different condition() result — or no store) and `error` (a throwing
    // key()/keyGenerator/store.get keeps lookupRoute's render-uncached
    // contract; the canonical record must not serve across a broken key
    // partition). The outcome comes from the lookup itself, not a re-run of
    // the condition, so a flapping predicate cannot re-admit the fallback.
    // Gated on the marker's `onExplicitHit`, set ONLY on the
    // navigation-replay serve path: a CAPTURE render must never fall back
    // here — its marker store reads through to the real store, and a
    // doc-keyed hit would replay the previous generation's segments instead
    // of re-running handlers (breaking SWR recapture freshness). Intercepts
    // stay source-dependent on their normal cache path (match-api never arms
    // replay for them).
    const replayMarker = pipelineReqCtx?._shellImplicitCache;
    if (
      replayMarker?.onExplicitHit &&
      !ctx.isIntercept &&
      !ctx.cacheScope.isShellImplicitDocScope
    ) {
      if (explicitLookup.status === "hit") {
        replayMarker.onExplicitHit();
      } else if (explicitLookup.status === "miss" && replayMarker.store) {
        // The store gate keeps report-only markers (installed on the
        // no-eligible-snapshot path purely for truthful status) inert: a
        // store-less marker minting a doc scope here would resolve the APP
        // store and read the REAL doc: partition — a cross-partition serve.
        cacheResult = await createShellImplicitDocScope(
          replayMarker,
        ).lookupRoute(ctx.pathname, ctx.matched.params, ctx.isIntercept);
      } else if (explicitLookup.status === "bypass") {
        // condition() refused at lookup time (the gate only pre-decides the
        // static cache(false) case) — report cache-disabled truthfully.
        replayMarker.onExplicitBypass?.();
      }
      // "error" stays unreported: the render is fresh and the seeded record
      // was not consulted, which is exactly what snapshot-miss describes; the
      // store already routed the failure through reportCacheError.
    }

    if (!cacheResult) {
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

    state.cacheHit = true;
    state.cacheSource = "runtime";
    state.shouldRevalidate = cacheResult.shouldRevalidate;
    state.cachedSegments = cacheResult.segments;
    state.cachedMatchedIds = cacheResult.segments.map((s) => s.id);
    const pprTransitionDecisions = pipelineReqCtx?._pprTransitionDecisions;

    const canCheckSegmentRevalidation =
      !ctx.isFullMatch &&
      ctx.clientSegmentSet.size > 0 &&
      !!buildEntryRevalidateMap;
    const entryRevalidateMap = canCheckSegmentRevalidation
      ? buildEntryRevalidateMap(ctx.entries)
      : undefined;

    for (const segment of cacheResult.segments) {
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

      if (segment.namespace?.startsWith("intercept:")) {
        yield segment;
        continue;
      }

      const entryInfo = entryRevalidateMap?.get(segment.id);

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
        // A PPR transition decision must reach the client even when this cached
        // segment otherwise needs no update. Keep its replayed component so the
        // partial result retains the segment for gateTransitions().
        if (!pprTransitionDecisions?.has(segment.id)) {
          segment.component = null;
          segment.loading = undefined;
        }
        yield segment;
        continue;
      }

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

      observeEvent({
        type: "revalidation.decision",
        timestamp: performance.now(),
        segmentId: segment.id,
        pathname: ctx.pathname,
        routeKey: ctx.routeKey,
        shouldRevalidate,
      });

      if (!shouldRevalidate && !pprTransitionDecisions?.has(segment.id)) {
        segment.component = null;
        segment.loading = undefined;
      }

      yield segment;
    }

    const barrierReqCtx = pipelineReqCtx;
    if (barrierReqCtx) {
      if (barrierReqCtx._treeHasStreaming === undefined) {
        barrierReqCtx._treeHasStreaming = treeHasStreaming(ctx.entries);
      }
      barrierReqCtx._resolveRenderBarrier(cacheResult.segments);
    }

    // Resolve loaders fresh (loaders are never cached). Shared with the
    // prerender-store path via resolveFreshLoadersAndYield.
    yield* resolveFreshLoadersAndYield(
      ctx,
      state,
      pipelineStart,
      ms,
      resolveLoadersOnly,
      resolveLoadersOnlyWithRevalidation,
    );
  };
}
