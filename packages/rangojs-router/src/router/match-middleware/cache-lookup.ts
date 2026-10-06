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
import type { InternalHandlerContext, ResolvedSegment } from "../../types.js";
import { isPprEntry, type EntryData } from "../../server/context.js";
import type { MatchContext, MatchPipelineState } from "../match-context.js";
import { getRouterContext, type RouterContext } from "../router-context.js";
import { observeEvent } from "../instrument.js";
import { pushRevalidationTraceEntry, isTraceActive } from "../logging.js";
import { treeHasStreaming } from "./segment-resolution.js";
import { loaderPins } from "../segment-resolution/loader-cache.js";
import type { PrerenderStore, PrerenderEntry } from "../../prerender/store.js";
import {
  isStoredEntryStale,
  readVerifiedStoredEntry,
  serializePrerenderKey,
  type PrerenderKey,
} from "../../prerender/writable-store.js";
import { IN_FLIGHT_LEADER_MAX_WAIT_MS } from "../../cache/cache-policy.js";
import type {
  PrerenderTargetObject,
  ResolvedPrerender,
} from "../../prerender/on-demand.js";
import {
  _getRequestContext,
  type RequestContext,
} from "../../server/request-context.js";
import {
  createShellImplicitDocScope,
  type CacheScope,
} from "../../cache/cache-scope.js";
import { ShellRecordUnavailableError } from "../../cache/shell-snapshot.js";
import { prerenderStoreShortCircuits } from "../navigation-snapshot.js";
import { paramsEqual } from "../params-util.js";
import { requestHeaders } from "../../server/request-headers.js";

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
let _restoreRecordHandles:
  | typeof import("../../cache/handle-snapshot.js").restoreRecordHandles
  | undefined;
let _hashParams:
  | typeof import("../../prerender/param-hash.js").hashParams
  | undefined;

/**
 * @internal Replace the prerender store this module serves from, and return
 * the one it replaced. For serveShellRequest (testing/serve-shell-request.ts),
 * which installs the production store over the artifacts it bakes for a call
 * and puts the previous one back after it.
 */
export function setPrerenderStoreForTests(
  store: PrerenderStore | null | undefined,
): PrerenderStore | null | undefined {
  const previous = prerenderStoreInstance;
  prerenderStoreInstance = store;
  return previous;
}

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
    _restoreRecordHandles = snapshot.restoreRecordHandles;
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
  entries: EntryData[],
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
        resolveLoadersOnly(entries, ctx.handlerContext),
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
          entries,
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
  /**
   * The entry may be newer than the client's copy: an on-demand overlay entry
   * that a refresh (possibly inside this very action) replaced. On an action
   * the route's own segments are then re-sent, as a live action re-render
   * re-sends them (revalidation.ts "action:route-segment"); the immutable
   * bundled manifest keeps the client's copy.
   */
  replaceable?: boolean,
): AsyncGenerator<ResolvedSegment> {
  if (
    !_deserializeSegments ||
    !_fragmentSegments ||
    !_restoreHandles ||
    !_decodeHandles ||
    !_restoreRecordHandles ||
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

  // Before the render barrier freezes the document snapshot.
  const shellHandles = reqCtx?._shellImplicitCache?.prerenderHandles;
  if (handleStore && shellHandles) {
    await _restoreRecordHandles!(
      handleStore,
      shellHandles,
      loaderPins(ctx.entries, reqCtx),
    );
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
  const resendRouteSegments = replaceable === true && ctx.isAction;
  for (const segment of segments) {
    if (
      !ctx.isFullMatch &&
      !paramsChanged &&
      ctx.clientSegmentSet.has(segment.id) &&
      !(
        resendRouteSegments &&
        (segment.type === "route" || segment.belongsToRoute === true)
      )
    ) {
      keepClientSegment(segment);
    }
    yield segment;
  }

  // Resolve loaders fresh (loaders are never pre-rendered/cached).
  yield* resolveFreshLoadersAndYield(
    ctx,
    ctx.entries,
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
  // Non-intercept variant only: whether the navigation is an intercept (which
  // reads `paramHash + "/i"`) resolves during the match. A wrong guess is
  // reclassified post-match from `_pprReplayPostMatchReason`.
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
 * Serialized overlay key -> start time of its in-flight `onRevalidate`.
 * Dedupes the obvious Node wiring, `(t, env) => router.prerender(t, { env })`,
 * and queue sends alike, per isolate. Entries older than
 * IN_FLIGHT_LEADER_MAX_WAIT_MS count as free: a never-settling onRevalidate
 * (hung queue send) or a killed execution context never runs `.finally`, and
 * would otherwise pin the key for the isolate's lifetime.
 */
const overlayRevalidationsInFlight = new Map<string, number>();

/** @internal Tests only (testing/serve-shell-request.ts resetShellTestState). */
export function resetOverlayRevalidationsForTests(): void {
  overlayRevalidationsInFlight.clear();
}

/** @internal Exported for the eviction unit test. */
export function scheduleOverlayRevalidation<TEnv>(
  serializedKey: string,
  onRevalidate: NonNullable<ResolvedPrerender["config"]["onRevalidate"]>,
  target: PrerenderTargetObject,
  reqCtx: RequestContext<TEnv>,
  now: number = Date.now(),
): void {
  // waitUntil is a no-op under build contexts: nothing would clear the key.
  if (reqCtx.build) return;
  const startedAt = overlayRevalidationsInFlight.get(serializedKey);
  if (
    startedAt !== undefined &&
    now - startedAt < IN_FLIGHT_LEADER_MAX_WAIT_MS
  ) {
    return;
  }
  overlayRevalidationsInFlight.set(serializedKey, now);
  const env = reqCtx.env;
  const executionContext = reqCtx.executionContext;
  const reportError = reqCtx._reportBackgroundError;
  // The stale entry still serves this request; this only schedules.
  reqCtx.waitUntil(() =>
    Promise.resolve()
      .then(() => onRevalidate(target, env, executionContext))
      .then(
        () => {},
        (err) => {
          // A failed onRevalidate must not fail the response, but must reach
          // onError like the runtime cache's stale-revalidation failures.
          reportError?.(err, "stale-revalidation");
        },
      )
      .finally(() => {
        // An evicted-and-rescheduled entry belongs to the newer run.
        if (overlayRevalidationsInFlight.get(serializedKey) === now) {
          overlayRevalidationsInFlight.delete(serializedKey);
        }
      }),
  );
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
  isPassthroughPrerenderRoute: boolean,
  overlay?: ResolvedPrerender,
): AsyncGenerator<ResolvedSegment, boolean> {
  // 1. Writable durable overlay (per-request, env-scoped), read before the
  //    bundled manifest: it is always newer. Only on-demand routes are read
  //    (router.prerender() refuses non-od routes, so a pr-only route always
  //    misses), and never for intercept navigations (only the main variant is
  //    written). Actions read it too: a plain on-demand route has no live
  //    handler, so skipping the overlay would 404 an overlay-only param
  //    (gateOnDemandProducer). A store error degrades to a miss
  //    (readVerifiedStoredEntry); a stale hit serves and may schedule onRevalidate.
  if (overlay && ctx.matched.od && !ctx.isIntercept) {
    const key: PrerenderKey = {
      routerId: overlay.routerId,
      version: overlay.version,
      routeName: ctx.matched.routeKey,
      paramHash: _hashParams!(ctx.matched.params),
    };
    const stored = await readVerifiedStoredEntry(
      overlay.config.store,
      key,
      ctx.matched.params,
    );
    if (stored) {
      // A stale "removed" marker is rechecked like a stale page: only a
      // refresh that hit notFound() (or declined) stamps one with a ttl or
      // tags. A prerender.remove() marker has neither and never gets here.
      if (
        overlay.config.onRevalidate &&
        reqCtx &&
        isStoredEntryStale(stored, Date.now())
      ) {
        scheduleOverlayRevalidation(
          serializePrerenderKey(key),
          overlay.config.onRevalidate,
          {
            route: ctx.matched.routeKey,
            params: ctx.matched.params,
          } as PrerenderTargetObject,
          reqCtx,
        );
      }
      if (stored.removed === true) {
        // The page was removed. Not served, and step 2 is skipped: the
        // build-time entry below must not come back. The route's handler
        // answers: a Passthrough route's live handler, or a plain route's
        // gated producer, which `_prerenderRemoved` makes a 404 in dev too
        // (gateOnDemandProducer).
        (
          ctx.handlerContext as InternalHandlerContext<any, TEnv>
        )._prerenderRemoved = true;
        return false;
      }
      yield* yieldFromStore(
        stored.entry,
        ctx,
        state,
        pipelineStart,
        reqCtx,
        resolveLoadersOnly,
        resolveLoadersOnlyWithRevalidation,
        true,
      );
      return true;
    }
  }

  // 2. Bundled build manifest (immutable). Absent for on-demand-only routes.
  if (prerenderStoreInstance) {
    const paramHash = _hashParams!(ctx.matched.params);
    const entry = await prerenderStoreInstance.get(
      ctx.matched.routeKey,
      ctx.isIntercept ? paramHash + "/i" : paramHash,
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
        reqCtx,
        resolveLoadersOnly,
        resolveLoadersOnlyWithRevalidation,
      );
      return true;
    }
  }

  return false;
}

/**
 * Keep the client's copy of a stored (runtime cache, prerender, or shell
 * replay) segment this navigation does not re-render. collectMatchResult
 * (match-result.ts) omits a null-component segment the client holds, as the
 * live partial path omits a segment whose revalidation said no
 * (segment-resolution/revalidation.ts).
 *
 * A transition({ when }) is no exception: it is decided in the browser for
 * kept segments too, so no segment is re-sent to carry a decision (#986).
 */
function keepClientSegment(segment: ResolvedSegment): void {
  segment.component = null;
  segment.loading = undefined;
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
    // Per-request writable prerender overlay (durable), resolved by the handler.
    const prerenderOverlay = pipelineReqCtx?._prerender;

    const {
      evaluateRevalidation,
      buildEntryRevalidateMap,
      resolveLoadersOnlyWithRevalidation,
      resolveLoadersOnly,
      resolveAllSegments,
      resolveAllSegmentsWithRevalidation,
    } = getRouterContext<TEnv>();

    // An on-demand route may have no build-baked entry yet still needs a
    // writable-overlay lookup, so od joins pr in the gate. The retained producer
    // is NEVER run by this pipeline: a miss falls through like pr + miss.
    const isPassthroughPrerenderRoute = ctx.entries.some(
      (entry) => entry.type === "route" && entry.isPassthrough === true,
    );
    const overlayEligible =
      ctx.matched.od === true && !requestHeaders(ctx.request).get("X-RSC-HMR");
    if (
      prerenderStoreShortCircuits(ctx.matched.pr, ctx.request) ||
      overlayEligible
    ) {
      // Actions normally re-render fresh and skip the prerender store. But a pure
      // Prerender route's handler is evicted at build, so there is no fresh
      // handler to run on an action re-render -- without the fallback the
      // re-render falls through to the evicted handler and throws "No prerender
      // data found". Serve the prerendered entry instead (the action ran already;
      // its result is applied client-side via useActionState). A plain on-demand
      // route is the same case, served from the overlay first (an overlay entry
      // is newer than the build one, and may be the only one). Passthrough
      // routes keep a liveHandler, so they still re-render fresh on actions.
      if (!ctx.isAction || !isPassthroughPrerenderRoute) {
        await ensurePrerenderDeps();
        if (prerenderStoreInstance || prerenderOverlay) {
          const served = yield* tryPrerenderLookup(
            ctx,
            state,
            pipelineStart,
            pipelineReqCtx,
            resolveLoadersOnly,
            resolveLoadersOnlyWithRevalidation,
            isPassthroughPrerenderRoute,
            prerenderOverlay,
          );
          if (served) return;
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
            isPassthroughPrerenderRoute,
          );
          if (served) return;
        }
      }
    }

    // A document HIT tail replays the handler layer through the implicit doc
    // scope and never runs a handler: without that scope (a context that lost
    // the marker before the scope resolved), fail like a lookup miss instead
    // of falling through to the handlers below.
    const tailMarker = pipelineReqCtx?._shellImplicitCache;
    if (tailMarker?.docTail && !ctx.cacheScope?.isShellImplicitDocScope) {
      throw new ShellRecordUnavailableError(tailMarker.fixedDocKey);
    }

    if (ctx.isAction || !ctx.cacheScope?.enabled) {
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

    // Only a ppr route's records hold loader pushes, and only its shell pins
    // loaders (CachedEntryData.handleOwners, the loader seed): any other
    // route's record restores as a plain replay.
    const leaf = ctx.entries[ctx.entries.length - 1];
    const ownedPushes =
      leaf !== undefined && isPprEntry(leaf)
        ? () => loaderPins(ctx.entries, pipelineReqCtx)
        : undefined;
    const explicitLookup = await ctx.cacheScope.lookupRouteDetailed(
      ctx.pathname,
      ctx.matched.params,
      ctx.isIntercept,
      ownedPushes,
    );
    let cacheResult =
      explicitLookup.status === "hit" ? explicitLookup.result : null;
    // The scope whose record answered decides which entries it covers.
    let hitScope: CacheScope = ctx.cacheScope;

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
        hitScope = createShellImplicitDocScope(replayMarker);
        cacheResult = await hitScope.lookupRoute(
          ctx.pathname,
          ctx.matched.params,
          ctx.isIntercept,
          ownedPushes,
        );
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
      // A document shell HIT tail replays the handler layer from the entry's
      // doc record and must never run a handler behind the committed prelude:
      // a record that did not hit (it failed to decode, or the entry lost it)
      // ends the tail here; serveShellHit degrades the response.
      if (replayMarker?.docTail) {
        throw new ShellRecordUnavailableError(replayMarker.fixedDocKey);
      }
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

    // Entries above the cache() boundary are not in the record: resolve them
    // fresh, exactly as an uncached render of this request would.
    const boundaryIndex =
      hitScope.boundary === undefined
        ? 0
        : Math.max(
            0,
            ctx.entries.findIndex((e) => e.shortCode === hitScope.boundary),
          );
    let liveSegments: ResolvedSegment[] = [];
    let liveMatchedIds: string[] = [];
    if (boundaryIndex > 0) {
      const liveEntries = ctx.entries.slice(0, boundaryIndex);
      const live: { segments: ResolvedSegment[]; matchedIds: string[] } =
        await ctx.Store.run(async () => {
          if (!ctx.isFullMatch) {
            return resolveAllSegmentsWithRevalidation(
              liveEntries,
              ctx.routeKey,
              ctx.matched.params,
              ctx.handlerContext,
              ctx.clientSegmentSet,
              ctx.prevParams,
              ctx.request,
              ctx.prevUrl,
              ctx.url,
              ctx.actionContext,
              ctx.interceptResult,
              ctx.localRouteName,
              ctx.pathname,
              ctx.stale,
              ctx.entries,
            );
          }
          // The full chain keeps a bare cache() marker, which also sits in
          // its layout's orphan list, out of the live pass: the record
          // supplies it and its subtree (issue #918).
          const segments = await resolveAllSegments(
            liveEntries,
            ctx.routeKey,
            ctx.matched.params,
            ctx.handlerContext,
            ctx.loaderPromises,
            { chain: ctx.entries },
          );
          return { segments, matchedIds: segments.map((s) => s.id) };
        });
      // The record supplies every covered segment.
      liveSegments = live.segments.filter(
        (s) => !hitScope.covers(s.id, s.namespace),
      );
      liveMatchedIds = live.matchedIds.filter((id) => !hitScope.covers(id));
    }

    state.cacheHit = true;
    state.cacheSource = "runtime";
    state.shouldRevalidate = cacheResult.shouldRevalidate;
    state.cachedSegments = cacheResult.segments;
    state.cachedMatchedIds = [
      ...liveMatchedIds,
      ...cacheResult.segments.map((s) => s.id),
    ];

    const canCheckSegmentRevalidation =
      !ctx.isFullMatch &&
      ctx.clientSegmentSet.size > 0 &&
      !!buildEntryRevalidateMap;
    const entryRevalidateMap = canCheckSegmentRevalidation
      ? buildEntryRevalidateMap(ctx.entries)
      : undefined;

    yield* liveSegments;

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
        keepClientSegment(segment);
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

      if (!shouldRevalidate) keepClientSegment(segment);

      yield segment;
    }

    const barrierReqCtx = pipelineReqCtx;
    if (barrierReqCtx) {
      if (barrierReqCtx._treeHasStreaming === undefined) {
        barrierReqCtx._treeHasStreaming = treeHasStreaming(ctx.entries);
      }
      barrierReqCtx._resolveRenderBarrier(
        liveSegments.length > 0
          ? [...liveSegments, ...cacheResult.segments]
          : cacheResult.segments,
      );
    }

    // Resolve loaders fresh (loaders are never cached). Shared with the
    // prerender-store path via resolveFreshLoadersAndYield. The live pass
    // already resolved the loaders of the entries above the boundary.
    yield* resolveFreshLoadersAndYield(
      ctx,
      ctx.entries.slice(boundaryIndex),
      state,
      pipelineStart,
      ms,
      resolveLoadersOnly,
      resolveLoadersOnlyWithRevalidation,
    );
  };
}
