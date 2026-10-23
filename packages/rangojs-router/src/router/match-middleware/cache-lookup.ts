/**
 * Cache Lookup Middleware
 *
 * First middleware in the pipeline. Before segment resolution runs, it serves
 * a stored match from the first source that answers:
 *
 *   1. Prerender: the writable on-demand overlay, then the bundled build
 *      manifest. A live render (an action or a stale partial) reads them too
 *      when the route has no live handler (not a Passthrough).
 *   2. The dev Static store (`__PRERENDER_DEV_URL`, isStaticPrerender entries).
 *   3. The route's cache() record (the segment cache). An action or a stale
 *      partial renders live (rendersLive) and reads no record.
 *
 * Every source serves through serveStoredSegments: pre-rendering is caching
 * at build time, so a prerender entry is a cache hit through the same segment
 * path. When no source answers, the request passes through to
 * segment-resolution.
 *
 * A STORED HIT
 * ============
 *
 *   - state.cacheHit = true signals downstream middleware to skip
 *   - A segment the client already holds and keeps has its component nullified
 *   - Loaders are always re-resolved fresh: never cached or pre-rendered.
 *     Segment cache staleness does NOT propagate to loader revalidation;
 *     loaders use their own revalidation rules (actionId, user-defined)
 *   - A cache() record sets state.shouldRevalidate, which triggers background
 *     SWR when the record was stale
 *
 * REVALIDATION RULES (cache() record)
 * ===================================
 *
 * Each record segment the client holds is evaluated against its rules:
 *
 *   1. No rules defined -> re-render the route's own segments when the search
 *      or the route params changed; otherwise skip (nullify component)
 *   2. Rules return false -> skip re-render (nullify component)
 *   3. Rules return true -> re-render (keep component)
 *
 * Revalidation context includes the previous/next URL and params, the request
 * and the action context (if POST).
 */
import type { InternalHandlerContext, ResolvedSegment } from "../../types.js";
import { isPprEntry, type EntryData } from "../../server/context.js";
import {
  rendersLive,
  resolutionPassInput,
  type MatchContext,
  type MatchPipelineState,
} from "../match-context.js";
import { getRouterContext, type RouterContext } from "../router-context.js";
import { freshPassInput } from "../segment-resolution/resolution-pass.js";
import { observeEvent } from "../instrument.js";
import { pushRevalidationTraceEntry, isTraceActive } from "../logging.js";
import { treeHasStreaming } from "./segment-resolution.js";
import { loaderPins } from "../segment-resolution/loader-cache.js";
import {
  fillSends,
  interceptFillSkips,
  recordUse,
} from "../segment-resolution/prefetch-deferral.js";
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
import { isInterceptSegment } from "../../browser/intercept-utils.js";

// Lazily initialized prerender store singleton and dynamically imported deps.
// Dynamic imports prevent pulling in @vitejs/plugin-rsc/rsc virtual module at
// top-level, which breaks vitest (only URLs with file:, data:, node: schemes).
let prerenderStoreInstance: PrerenderStore | null | undefined;
let codec: typeof import("../../cache/segment-codec.js") | undefined;
let handleSnapshot: typeof import("../../cache/handle-snapshot.js") | undefined;
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

async function ensurePrerenderDeps(): Promise<void> {
  if (codec) return;
  const [segmentCodec, snapshot, paramHash, store] = await Promise.all([
    import("../../cache/segment-codec.js"),
    import("../../cache/handle-snapshot.js"),
    import("../../prerender/param-hash.js"),
    import("../../prerender/store.js"),
  ]);
  codec = segmentCodec;
  handleSnapshot = snapshot;
  _hashParams = paramHash.hashParams;
  if (prerenderStoreInstance === undefined) {
    prerenderStoreInstance = store.createPrerenderStore();
  }
}

/**
 * Where a stored match is read from. Each source serves through
 * serveStoredSegments: a prerender entry is a cache hit through the same
 * segment path (prerender-api-design.md, "Core Principle").
 *
 * - `segment-cache`: a cache() record, decoded with its handles replayed by
 *   the lookup; `scope` is the scope whose record answered.
 * - `prerender-build`: the bundled build manifest (immutable).
 * - `prerender-overlay`: the writable on-demand overlay. Its entry may be
 *   newer than the client's copy: one that a refresh (possibly inside this
 *   very action) replaced.
 */
type StoredSegmentSource =
  | {
      kind: "segment-cache";
      segments: ResolvedSegment[];
      shouldRevalidate: boolean;
      scope: CacheScope;
    }
  | { kind: "prerender-build" | "prerender-overlay"; entry: PrerenderEntry };

/**
 * Decode a prerender entry's segments and replay its handle data into the
 * request's HandleStore, as the cache scope's lookup does for a record.
 */
async function decodeStoredEntry<TEnv>(
  entry: PrerenderEntry,
  ctx: MatchContext<TEnv>,
  reqCtx: RequestContext<TEnv> | undefined,
): Promise<ResolvedSegment[]> {
  // Shell-HIT tail (issue #700): a Prerender+ppr route's tail serves from THIS
  // store (the prerender lookup runs before the cache scope), so the fragment
  // splice must apply here too — otherwise producer B entries re-serialize the
  // whole tree per request while producer A entries do not.
  const segments = reqCtx?._shellFragmentPayload
    ? await codec!.fragmentSegments(entry.segments)
    : await codec!.deserializeSegments(entry.segments);

  // entry.handles is a Flight-encoded string ("" when none) — decode before
  // restore so Promise/ReactNode handle values are revived, not the corrupted
  // JSON form.
  const handleStore = reqCtx?._handleStore;
  if (handleStore && entry.handles) {
    const handlesRecord = await handleSnapshot!.decodeHandles(entry.handles);
    if (handlesRecord) {
      handleSnapshot!.restoreHandles(handlesRecord, handleStore);
    }
  }

  // Before the render barrier freezes the document snapshot.
  const shellHandles = reqCtx?._shellImplicitCache?.prerenderHandles;
  if (handleStore && shellHandles) {
    await handleSnapshot!.restoreRecordHandles(
      handleStore,
      shellHandles,
      loaderPins(ctx.entries, reqCtx),
    );
  }

  // Post-match serve-source truth for the PPR replay reporter. This overwrites
  // `intercept` because the prerender store is the response source.
  if (reqCtx) reqCtx._pprReplayPostMatchReason = "prerender-store";
  return segments;
}

/**
 * Whether a cache() record's segment is sent: one the client lacks, an
 * intercept's, or one its revalidate rules re-render. Without rules, the
 * route's own segments are re-rendered when the search or the route params
 * changed. A segment with rules answers with their pending decision, which
 * serveStoredSegments awaits and observes.
 */
function cachedSegmentSends<TEnv>(
  ctx: MatchContext<TEnv>,
  cacheStale: boolean,
  reqCtx: RequestContext<TEnv> | undefined,
  router: RouterContext<TEnv>,
): (segment: ResolvedSegment) => boolean | Promise<boolean> {
  const entryRevalidateMap =
    !ctx.isFullMatch &&
    ctx.clientSegmentSet.size > 0 &&
    router.buildEntryRevalidateMap
      ? router.buildEntryRevalidateMap(ctx.entries)
      : undefined;
  const searchChanged =
    ctx.prevUrl.search !== ctx.url.search || reqCtx?._visitorMoved === true;
  const routeParamsChanged = !paramsEqual(ctx.matched.params, ctx.prevParams);
  const trace = (
    segment: ResolvedSegment,
    shouldRevalidate: boolean,
    reason: string,
  ): boolean => {
    if (isTraceActive()) {
      pushRevalidationTraceEntry({
        segmentId: segment.id,
        segmentType: segment.type,
        belongsToRoute: segment.belongsToRoute ?? false,
        source: "cache-hit",
        defaultShouldRevalidate: shouldRevalidate,
        finalShouldRevalidate: shouldRevalidate,
        reason,
      });
    }
    return shouldRevalidate;
  };

  return (segment) => {
    if (!ctx.clientSegmentSet.has(segment.id)) {
      return trace(segment, true, "new-segment");
    }
    // A fill keeps a held segment outright (fillSends), an intercept's
    // included.
    if (
      fillSends(ctx.handlerContext, segment.id, ctx.clientSegmentSet) === false
    ) {
      return false;
    }
    if (isInterceptSegment(segment)) return true;

    const entryInfo = entryRevalidateMap?.get(segment.id);
    if (!entryInfo || entryInfo.revalidate.length === 0) {
      const shouldDefaultRevalidate =
        (searchChanged || routeParamsChanged) &&
        (segment.type === "route" ||
          (segment.belongsToRoute === true &&
            (segment.type === "layout" || segment.type === "parallel")));
      return trace(
        segment,
        shouldDefaultRevalidate,
        !shouldDefaultRevalidate
          ? "cached-no-rules"
          : routeParamsChanged
            ? "cached-params-changed"
            : "cached-search-changed",
      );
    }

    return router.evaluateRevalidation({
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
      cacheStale,
      traceSource: "cache-hit",
    });
  };
}

/**
 * Whether a prerender entry's segment is sent. On a partial navigation the
 * client keeps the segments it holds, so parent layouts stay live; when the
 * params changed (e.g., a different guide slug) the segments have different
 * content and are all sent. An overlay entry may be newer than the client's
 * copy: on an action or a stale request the route's own segments are re-sent,
 * as a live action re-render re-sends them (revalidation.ts
 * "action:route-segment"); the immutable bundled manifest keeps the client's
 * copy.
 */
function storedEntrySends<TEnv>(
  ctx: MatchContext<TEnv>,
  replaceable: boolean,
): (segment: ResolvedSegment) => boolean {
  const paramsChanged =
    !ctx.isFullMatch && !paramsEqual(ctx.matched.params, ctx.prevParams);
  const resendRouteSegments = replaceable && (ctx.isAction || ctx.stale);
  return (segment) =>
    ctx.isFullMatch ||
    !ctx.clientSegmentSet.has(segment.id) ||
    // A fill keeps it (fillSends); otherwise it is sent again when the params
    // changed or an action re-sends the route's own segments.
    (fillSends(ctx.handlerContext, segment.id, ctx.clientSegmentSet) ??
      (paramsChanged ||
        (resendRouteSegments &&
          (segment.type === "route" || segment.belongsToRoute === true))));
}

/**
 * Serve a stored match from the first source that answers (the order is in
 * the module header), or pass `upstream` through when none does. Every
 * StoredSegmentSource serves here: the stored segments, minus the ones the
 * client keeps, then the loaders resolved fresh (loaders are never cached or
 * pre-rendered). By source: a prerender entry is decoded here, a cache()
 * record also resolves the entries above its boundary live and sets
 * state.shouldRevalidate, and each decides which held segments are sent
 * again.
 *
 * The reads and the serve share this generator: a HIT is the request hot
 * path, and serving from a second generator behind `yield*` adds a microtask
 * turn and two promises for each segment it yields, and once more at its end.
 */
async function* serveStoredSegments<TEnv>(
  ctx: MatchContext<TEnv>,
  state: MatchPipelineState,
  upstream: AsyncGenerator<ResolvedSegment>,
): AsyncGenerator<ResolvedSegment> {
  const pipelineStart = performance.now();

  // Eagerly capture the HandleStore before any async operations.
  // In workerd/Cloudflare, dynamic imports and fetch() inside the pipeline
  // can disrupt AsyncLocalStorage, causing getRequestContext() to return
  // undefined afterward. Capturing the reference early ensures handle replay
  // and handler handle-push work regardless of ALS state.
  const reqCtx = _getRequestContext<TEnv>();
  // Only the match can determine interception; the source header proves
  // nothing in either direction. Clear a stale reason on normal matches.
  if (reqCtx) {
    reqCtx._pprReplayPostMatchReason = ctx.isIntercept
      ? "intercept"
      : undefined;
  }
  // ALS-backed: captured before the first await, like reqCtx.
  const router = getRouterContext<TEnv>();
  let stored: StoredSegmentSource | null = null;

  // An on-demand route may have no build-baked entry yet still needs a
  // writable-overlay lookup, so od joins pr in the gate. The retained producer
  // is NEVER run by this pipeline: a miss falls through like pr + miss.
  const isPassthroughPrerenderRoute = ctx.entries.some(
    (entry) => entry.type === "route" && entry.isPassthrough === true,
  );
  const overlayEligible =
    ctx.matched.od === true && !requestHeaders(ctx.request).get("X-RSC-HMR");
  // Actions normally re-render fresh and skip the prerender store. But a pure
  // Prerender route's handler is evicted at build, so there is no fresh
  // handler to run on an action re-render -- without the fallback the
  // re-render falls through to the evicted handler and throws "No prerender
  // data found". Serve the prerendered entry instead (the action ran already;
  // its result is applied client-side via useActionState). A plain on-demand
  // route is the same case, served from the overlay first (an overlay entry
  // is newer than the build one, and may be the only one). Passthrough
  // routes keep a liveHandler, so a live render (rendersLive) re-renders
  // them fresh.
  if (
    (prerenderStoreShortCircuits(ctx.matched.pr, ctx.request) ||
      overlayEligible) &&
    (!rendersLive(ctx) || !isPassthroughPrerenderRoute)
  ) {
    await ensurePrerenderDeps();
    stored = await readPrerenderSource(
      ctx,
      reqCtx,
      isPassthroughPrerenderRoute,
      // Per-request writable prerender overlay (durable), resolved by the handler.
      reqCtx?._prerender,
    );
  }

  if (
    !stored &&
    !rendersLive(ctx) &&
    !ctx.matched.pr &&
    globalThis.__PRERENDER_DEV_URL &&
    ctx.entries.some(
      (e) =>
        (e.type === "layout" || e.type === "route" || e.type === "parallel") &&
        e.isStaticPrerender,
    )
  ) {
    await ensurePrerenderDeps();
    stored = await readPrerenderSource(
      ctx,
      reqCtx,
      isPassthroughPrerenderRoute,
    );
  }

  stored ??= await readSegmentCacheSource(ctx, reqCtx);
  if (!stored) {
    yield* upstream;
    const ms = ctx.metricsStore;
    if (ms) {
      ms.metrics.push({
        label: "pipeline:cache-miss",
        duration: performance.now() - pipelineStart,
        startTime: pipelineStart - ms.requestStart,
      });
    }
    return;
  }
  const source: StoredSegmentSource = stored;

  const fromCache = source.kind === "segment-cache";
  const segments = fromCache
    ? source.segments
    : await decodeStoredEntry(source.entry, ctx, reqCtx);

  // Entries above the cache() boundary are not in the record: resolve them
  // fresh, exactly as an uncached render of this request would.
  const scope = fromCache ? source.scope : undefined;
  const boundary = scope?.boundary;
  const boundaryIndex =
    boundary === undefined
      ? 0
      : Math.max(
          0,
          ctx.entries.findIndex((e) => e.shortCode === boundary),
        );
  let liveSegments: ResolvedSegment[] = [];
  let liveMatchedIds: string[] = [];
  if (scope && boundaryIndex > 0) {
    const liveEntries = ctx.entries.slice(0, boundaryIndex);
    const live: { segments: ResolvedSegment[]; matchedIds: string[] } =
      await ctx.Store.run(async () => {
        // The full chain keeps a bare cache() marker, which also sits in
        // its layout's orphan list, out of the live pass: the record
        // supplies it and its subtree (issue #918).
        const result = await router.resolveAllSegmentsWithRevalidation(
          ctx.isFullMatch
            ? freshPassInput(
                ctx.handlerContext,
                ctx.routeKey,
                ctx.matched.params,
              )
            : resolutionPassInput(ctx),
          liveEntries,
          {
            interceptResult: ctx.interceptResult,
            localRouteName: ctx.localRouteName,
            pathname: ctx.pathname,
            chain: ctx.entries,
          },
        );
        return ctx.isFullMatch
          ? {
              segments: result.segments,
              matchedIds: result.segments.map((s) => s.id),
            }
          : result;
      });
    // The record supplies every covered segment.
    liveSegments = live.segments.filter(
      (s) => !scope.covers(s.id, s.namespace),
    );
    liveMatchedIds = live.matchedIds.filter((id) => !scope.covers(id));
  }

  state.cacheHit = true;
  state.cacheSource = fromCache ? "runtime" : "prerender";
  if (fromCache) state.shouldRevalidate = source.shouldRevalidate;
  state.cachedSegments = segments;
  const cachedMatchedIds = [...liveMatchedIds, ...segments.map((s) => s.id)];
  state.cachedMatchedIds = cachedMatchedIds;

  const sends = fromCache
    ? cachedSegmentSends(ctx, source.shouldRevalidate, reqCtx, router)
    : storedEntrySends(ctx, source.kind === "prerender-overlay");

  yield* liveSegments;

  for (const segment of segments) {
    if (interceptFillSkips(ctx, segment)) continue;
    let send = sends(segment);
    if (typeof send !== "boolean") {
      // A cache() record segment's revalidate() rules decided. Awaited here,
      // not chained in cachedSegmentSends: a .then() costs a turn and a
      // promise per segment.
      send = await send;
      observeEvent({
        type: "revalidation.decision",
        timestamp: performance.now(),
        segmentId: segment.id,
        pathname: ctx.pathname,
        routeKey: ctx.routeKey,
        shouldRevalidate: send,
      });
    }
    if (!send) keepClientSegment(segment);
    yield segment;
  }

  if (reqCtx) {
    if (reqCtx._treeHasStreaming === undefined) {
      reqCtx._treeHasStreaming = treeHasStreaming(ctx.entries);
    }
    reqCtx._resolveRenderBarrier(
      liveSegments.length > 0 ? [...liveSegments, ...segments] : segments,
    );
  }

  // Resolve loaders fresh. The live pass already resolved the loaders of the
  // entries above the boundary.
  const loaderStart = performance.now();
  const loaderEntries = ctx.entries
    .slice(boundaryIndex)
    .filter((e) => !interceptFillSkips(ctx, e.shortCode));
  const { resolveLoadersOnlyWithRevalidation } = router;
  if (resolveLoadersOnlyWithRevalidation) {
    const loaderResult = await ctx.Store.run(() =>
      resolveLoadersOnlyWithRevalidation(
        ctx.isFullMatch
          ? freshPassInput(ctx.handlerContext, ctx.routeKey, ctx.matched.params)
          : {
              ...resolutionPassInput(ctx),
              // Loaders are never cached in the segment cache, so segment
              // staleness must not propagate; browser-sent staleness
              // (ctx.stale) still must.
              stale: ctx.stale || undefined,
            },
        loaderEntries,
      ),
    );
    state.matchedIds = ctx.isFullMatch
      ? cachedMatchedIds
      : [...cachedMatchedIds, ...loaderResult.matchedIds];
    for (const segment of loaderResult.segments) {
      yield segment;
    }
  } else {
    state.matchedIds = cachedMatchedIds;
  }

  const ms = ctx.metricsStore;
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
 * Whether the prerender store holds a baked entry for this route + params.
 * Consulted by the PPR replay gate (matchPartialWithPprReplay), which must
 * only report `prerender-store` when the short-circuit below will actually
 * serve: a Passthrough(Prerender()) route with an unbaked/passthrough param
 * misses the store and renders live, and replay — including its heal
 * capture — must stay available for it (withCacheStore records the doc
 * record on that path; state.cacheSource is not "prerender"). The store
 * memoizes per routeKey/paramHash, so this probe and readPrerenderSource's
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
 * The prerendered (build-time cached) entry for the current route, or null on
 * a miss. Intercept navigations consult only the intercept-specific entry
 * (`paramHash + "/i"`); a miss there falls through to the normal pipeline so
 * intercept-resolution can run. Callers run `ensurePrerenderDeps()` first.
 */
async function readPrerenderSource<TEnv>(
  ctx: MatchContext<TEnv>,
  reqCtx: RequestContext<TEnv> | undefined,
  isPassthroughPrerenderRoute: boolean,
  overlay?: ResolvedPrerender,
): Promise<StoredSegmentSource | null> {
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
        return null;
      }
      return { kind: "prerender-overlay", entry: stored.entry };
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
    if (entry) return { kind: "prerender-build", entry };
  }

  return null;
}

/**
 * The cache() record that answers this request, or null when it renders: no
 * enabled scope, a live render, a request that reads no record, or a lookup
 * that did not hit.
 */
async function readSegmentCacheSource<TEnv>(
  ctx: MatchContext<TEnv>,
  reqCtx: RequestContext<TEnv> | undefined,
): Promise<StoredSegmentSource | null> {
  // A document HIT tail replays the handler layer through the implicit doc
  // scope and never runs a handler: without that scope (a context that lost
  // the marker before the scope resolved), fail like a lookup miss instead
  // of falling through to the handlers below.
  const tailMarker = reqCtx?._shellImplicitCache;
  if (tailMarker?.docTail && !ctx.cacheScope?.isShellImplicitDocScope) {
    throw new ShellRecordUnavailableError(tailMarker.fixedDocKey);
  }

  // A prefetch that defers a layout above the boundary (prefetch: false)
  // emits nothing the record holds: reading it would replay the handle
  // pushes of segments the response does not carry. withCacheStore skips
  // the write for the same request.
  if (
    rendersLive(ctx) ||
    !ctx.cacheScope?.enabled ||
    !recordUse(ctx.handlerContext).read
  ) {
    return null;
  }

  // Only a ppr route's records hold loader pushes, and only its shell pins
  // loaders (CachedEntryData.handleOwners, the loader seed): any other
  // route's record restores as a plain replay.
  const leaf = ctx.entries[ctx.entries.length - 1];
  const ownedPushes =
    leaf !== undefined && isPprEntry(leaf)
      ? () => loaderPins(ctx.entries, reqCtx)
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
  const replayMarker = reqCtx?._shellImplicitCache;
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
    return null;
  }
  return {
    kind: "segment-cache",
    segments: cacheResult.segments,
    shouldRevalidate: cacheResult.shouldRevalidate,
    scope: hitScope,
  };
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
 * The middleware is serveStoredSegments. It serves a stored match when one
 * answers, in this order: the prerender overlay and build store (Prerender
 * and on-demand routes), the dev Static store, then the route's cache()
 * record. It yields the stored segments and the loaders resolved fresh and
 * sets state.cacheHit (and state.shouldRevalidate for a cache() record, for
 * background SWR).
 *
 * If nothing answers, passes through to the next middleware.
 */
export function withCacheLookup<TEnv>(
  ctx: MatchContext<TEnv>,
  state: MatchPipelineState,
): GeneratorMiddleware<ResolvedSegment> {
  return (upstream) => serveStoredSegments(ctx, state, upstream);
}
