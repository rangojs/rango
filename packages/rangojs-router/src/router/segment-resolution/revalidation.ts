/**
 * The segment walker.
 *
 * Resolves a matched chain's segments (loaders, layouts, routes, parallels,
 * orphan layouts, error boundaries) in handler-first order. A partial request
 * re-resolves only what the client lacks and what a held segment's
 * revalidate() rules ask for. A full match (a document, the background
 * re-render of a route record, a build-time prerender) walks the same code
 * with `pass.client === FRESH` (resolution-pass.ts): every segment is new,
 * and the branches marked FRESH keep what the full match has always done
 * differently.
 */

import type { ReactNode } from "react";
import { invariant } from "../../errors";
import { revalidate } from "../loader-resolution.js";
import {
  evaluateRevalidation,
  type EvaluateRevalidationOptions,
} from "../revalidation.js";
import {
  getParallelEntries,
  getParallelSlotEntries,
  type EntryData,
  type LoaderEntry,
  type ParallelEntries,
  type ParallelEntryData,
} from "../../server/context";
import type {
  HandlerContext,
  InternalHandlerContext,
  ResolvedSegment,
  ShouldRevalidateFn,
} from "../../types";
import type { SegmentRevalidationResult } from "../types.js";
import type { InterceptResult } from "../router-context.js";
import { FRESH, type ResolutionPass } from "./resolution-pass.js";
import {
  debugLog,
  pushRevalidationTraceEntry,
  isTraceActive,
} from "../logging.js";
import { resolveLoaderData } from "./loader-cache.js";
import {
  entryLoadingMasksLoaders,
  isShellCaptureActive,
} from "./loader-mask.js";
import { _getRequestContext } from "../../server/request-context.js";
import {
  defersLoader,
  deferUnit,
  fillSends,
  getPrefetchDeferral,
  interceptFillSkips,
  registerDeferredLoader,
} from "./prefetch-deferral.js";
import {
  handleHandlerResult,
  warnOnStreamedResponse,
  tryStaticHandler,
  tryStaticSlot,
  resolveLayoutComponent,
  resolveWithErrorBoundary,
  buildLoaderErrorContext,
} from "./helpers.js";
import { applyViewTransitionDefault } from "./view-transition-default.js";
import { isLayoutLoaderCopy } from "../../client-urls/layout-loader-copies.js";
import { getRouterContext } from "../router-context.js";
import { observeEvent, observeSegmentHandler } from "../instrument.js";
import { withReverseScope, withSegmentPin } from "../handler-context.js";
import { runInSegmentTagScope } from "../../cache/cache-tag.js";
import { trackStreamedHandler } from "./streamed-handler-boundary.js";
import {
  track,
  RangoContext,
  runInsideLoaderScope,
  latchCachedHeaderScope,
  latchPprHeaderScopeForEntries,
} from "../../server/context.js";

/**
 * Trace a parallel slot that's being force-rendered on a full refetch (client
 * has no cached state). User revalidate fns are bypassed in this case — see
 * the call sites for the load-bearing rationale.
 */
function traceFullRefetchedParallelSlot(
  parallelId: string,
  belongsToRoute: boolean,
): void {
  if (!isTraceActive()) return;
  pushRevalidationTraceEntry({
    segmentId: parallelId,
    segmentType: "parallel",
    belongsToRoute,
    source: "parallel",
    defaultShouldRevalidate: true,
    finalShouldRevalidate: true,
    reason: "full-refetch",
  });
}

// ---------------------------------------------------------------------------
// Revalidation telemetry helper
// ---------------------------------------------------------------------------

/**
 * Emit revalidation.decision telemetry for a segment if a sink is configured.
 * Called after evaluateRevalidation returns to capture the decision.
 * Silently no-ops when called outside RouterContext (e.g. in unit tests).
 */
function emitRevalidationDecision(
  segmentId: string,
  pathname: string,
  routeKey: string,
  shouldRevalidate: boolean,
): void {
  observeEvent({
    type: "revalidation.decision",
    timestamp: performance.now(),
    segmentId,
    pathname,
    routeKey,
    shouldRevalidate,
  });
}

/** What evaluateRevalidation reads from the pass, the same for every segment. */
function revalidationInputOf<TEnv>(
  pass: ResolutionPass<TEnv>,
): Pick<
  EvaluateRevalidationOptions<TEnv>,
  | "prevParams"
  | "getPrevSegment"
  | "request"
  | "prevUrl"
  | "nextUrl"
  | "routeKey"
  | "context"
  | "actionContext"
  | "stale"
> {
  return {
    prevParams: pass.prevParams,
    getPrevSegment: null,
    // Only a build-time FRESH pass lacks a request, and it decides nothing.
    request: pass.request!,
    prevUrl: pass.prevUrl,
    nextUrl: pass.nextUrl,
    routeKey: pass.routeKey,
    context: pass.context,
    actionContext: pass.actionContext,
    stale: pass.stale,
  };
}

/**
 * Whether a segment the client holds (`pass.client`, the set resolution works
 * on) renders again. A fill keeps it (prefetch-deferral.ts fillSends): no
 * revalidate() predicate runs and nothing is traced or observed. Any other
 * request asks the segment's revalidate() chain, and `onEvaluated` sees that
 * answer.
 */
async function revalidateHeld<TEnv>(
  pass: ResolutionPass<TEnv>,
  {
    onEvaluated,
    ...held
  }: Pick<
    EvaluateRevalidationOptions<TEnv>,
    "segment" | "revalidations" | "traceSource"
  > & {
    onEvaluated?: (shouldRevalidate: boolean) => void;
  },
): Promise<boolean> {
  const fill = fillSends(pass.context, held.segment.id, pass.client);
  if (fill !== undefined) return fill;
  const shouldRevalidate = await evaluateRevalidation({
    ...revalidationInputOf(pass),
    ...held,
  });
  onEvaluated?.(shouldRevalidate);
  return shouldRevalidate;
}

// ---------------------------------------------------------------------------
// prefetch: false (prefetch-deferral.ts)
// ---------------------------------------------------------------------------

/**
 * How to deliver a loader a prefetch deferred, kept so deliverStartedLoaders
 * can deliver it after all. Keyed by the emitted segment object.
 */
const deferredLoaderRuns = new WeakMap<ResolvedSegment, () => unknown>();

/**
 * A deferred loader something started in this request (a handler that awaits
 * it with ctx.use(), or another loader) ran in the prefetch whatever its flag
 * says: deliver that run instead of having the fill run it a second time. A
 * reader starts it through its registration (prefetch-deferral.ts
 * startDeferredLoader), so the delivery's resolveLoaderData finds the same
 * run or cache() binding. Called once resolution has awaited every handler it
 * awaits; a streamed handler that reads the loader later is not seen, and
 * that loader runs again in the fill.
 */
export function deliverStartedLoaders<TEnv>(
  ctx: HandlerContext<any, TEnv>,
  segments: ResolvedSegment[],
): void {
  const plan = getPrefetchDeferral(ctx);
  if (plan?.mode !== "prefetch") return;
  const internal = ctx as InternalHandlerContext<any, TEnv>;
  const started = (loaderId: string): boolean =>
    plan.deferredLoaders?.get(loaderId)?.started === true ||
    internal._loaderStarted?.(loaderId) === true;
  for (const segment of segments) {
    if (!segment.deferred || segment.type !== "loader") continue;
    const run = deferredLoaderRuns.get(segment);
    if (!run || !started(segment.loaderId!)) continue;
    delete segment.deferred;
    segment.loaderData = run();
  }
}

// ---------------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------------

/**
 * Whose loaders a resolveOwnerLoaders call resolves: a route entry's (or the
 * entry its loaders are inherited into), or an intercept's, whose loaders are
 * loader segments of its slot (`${parent}.${slot}D${i}.${$$id}`).
 */
export interface LoaderOwner {
  readonly loaders: readonly LoaderEntry[];
  /** The segments' namespace: the entry id, or `intercept:${routeName}`. */
  readonly namespace: string;
  /** The segment id the loader ids extend and the handle pushes file under. */
  readonly segmentPrefix: string;
  /** Where a loader error renders (wrapLoaderPromise). */
  readonly boundary: EntryData;
  /**
   * resolveLoaderData's PPR bake/seed key for every loader (loader-cache.ts).
   * False for an intercept: never a document.
   */
  readonly bakeLane: boolean;
  /**
   * The owner declares loading(false). A FRESH pass then settles every loader
   * before the handler runs (resolveOwnerLoaders). Unset for an intercept.
   */
  readonly loadingDisabled?: boolean;
  readonly traceSource: "loader" | "intercept-loader";
}

/** A route entry as a LoaderOwner, under `shortCodeOverride` when inherited. */
export function ownerOf(
  entry: EntryData,
  shortCodeOverride?: string,
): LoaderOwner {
  return {
    loaders: entry.loader ?? [],
    namespace: entry.id,
    segmentPrefix: shortCodeOverride ?? entry.shortCode,
    boundary: entry,
    bakeLane: !entryLoadingMasksLoaders(entry.loading),
    loadingDisabled: entry.loading === false,
    traceSource: "loader",
  };
}

/**
 * resolveOwnerLoaders has something to resolve for `entry`'s loaders. The
 * walker checks before the call: most entries own none, and the async call
 * would cost a promise and microtask ticks for an empty result.
 */
function ownsLoaders(pass: ResolutionPass<any>, entry: EntryData): boolean {
  return !pass.skipLoaders && (entry.loader?.length ?? 0) > 0;
}

/** getParallelSlotEntries(parallels) lists a slot. */
function declaresSlot(parallels: ParallelEntries): boolean {
  for (const slot in parallels) {
    if (parallels[slot as `@${string}`]) return true;
  }
  return false;
}

/**
 * Register flagged loader $$ids on the request context and return their
 * indices. Must run BEFORE kickoff: rendered() checks the set to fail
 * fast on the barrier cycle (resolution awaits the loader, the barrier
 * awaits resolution).
 */
function registerAwaitBeforeFlushIds(
  loaderEntries: readonly LoaderEntry[],
): number[] {
  const awaitedIndices: number[] = [];
  for (let i = 0; i < loaderEntries.length; i++) {
    if (loaderEntries[i]!.awaitBeforeFlush) awaitedIndices.push(i);
  }
  if (awaitedIndices.length > 0) {
    const reqCtx = _getRequestContext();
    if (reqCtx) {
      reqCtx._awaitBeforeFlushLoaderIds ??= new Set();
      for (const i of awaitedIndices) {
        reqCtx._awaitBeforeFlushLoaderIds.add(loaderEntries[i]!.loader.$$id);
      }
    }
  }
  return awaitedIndices;
}

const AWAIT_BEFORE_FLUSH = { awaitBeforeFlush: true } as const;

/** Spread into a FRESH loader segment: the flag, or nothing. */
function stampAwaitBeforeFlush(
  loaderEntry: LoaderEntry,
): typeof AWAIT_BEFORE_FLUSH | undefined {
  return loaderEntry.awaitBeforeFlush === true ? AWAIT_BEFORE_FLUSH : undefined;
}

/**
 * The loaders of a partial pass that run, as indices into `owner.loaders`:
 * each one the client lacks, and each held one whose revalidate() rules ask
 * for it (kept outright in a fill, fillSends). Every decision is traced and
 * observed. `segmentIds` are the loaders' segment ids, by index.
 */
async function loadersToRerun<TEnv>(
  pass: ResolutionPass<TEnv>,
  owner: LoaderOwner,
  belongsToRoute: boolean,
  segmentIds: readonly string[],
): Promise<number[]> {
  const ctx = pass.context;
  const checks = await Promise.all(
    owner.loaders.map(async (loaderEntry, index) => {
      const segmentId = segmentIds[index]!;
      const shouldRun = await revalidate(
        async () => {
          if (!pass.client.has(segmentId)) {
            if (isTraceActive()) {
              pushRevalidationTraceEntry({
                segmentId,
                segmentType: "loader",
                belongsToRoute,
                source: owner.traceSource,
                defaultShouldRevalidate: true,
                finalShouldRevalidate: true,
                reason: "new-segment",
              });
            }
            return true;
          }

          const dummySegment: ResolvedSegment = {
            id: segmentId,
            namespace: owner.namespace,
            type: "loader",
            index,
            component: null,
            params: ctx.params,
            loaderId: loaderEntry.loader.$$id,
            // A clientUrls() layout() loader's copy is projected onto the
            // route but owned by a layout: it takes a layout's default.
            belongsToRoute:
              belongsToRoute && !isLayoutLoaderCopy(loaderEntry.loader),
          };

          return await revalidateHeld(pass, {
            segment: dummySegment,
            revalidations: loaderEntry.revalidate.map((fn, j) => ({
              name: `${owner.traceSource}-revalidate${j}`,
              fn,
            })),
            traceSource: owner.traceSource,
          });
        },
        async () => true,
        () => false,
      );
      emitRevalidationDecision(
        segmentId,
        ctx.pathname,
        pass.routeKey,
        shouldRun,
      );
      return shouldRun;
    }),
  );
  const indices: number[] = [];
  for (let i = 0; i < checks.length; i++) if (checks[i]) indices.push(i);
  return indices;
}

/**
 * The walker's one loader funnel: each loader is a segment, run when the
 * client lacks it, asked its revalidate() when held, kept outright in a fill
 * (fillSends), deferred in a prefetch that defers it (defersLoader).
 *
 * Loaders run lazily via ctx.use() and are memoized, so they run in
 * parallel. A FRESH pass kicks every loader off without an await, in the
 * tick the call starts: a reader's ctx.use(Loader) finds the binding only if
 * it registered first (docs/design/handle-push-ownership.md).
 */
export async function resolveOwnerLoaders<TEnv>(
  pass: ResolutionPass<TEnv>,
  owner: LoaderOwner,
  belongsToRoute: boolean,
): Promise<{ segments: ResolvedSegment[]; matchedIds: string[] }> {
  const loaderEntries = owner.loaders;
  if (loaderEntries.length === 0 || pass.skipLoaders) {
    return { segments: [], matchedIds: [] };
  }

  const ctx = pass.context;
  const shortCode = owner.segmentPrefix;
  const fresh = pass.client === FRESH;

  // Pin `_currentSegmentId` to the OWNING entry BEFORE the loader kickoffs:
  // createLoaderExecutor captures it synchronously at kickoff for
  // ctx.use(Handle) push attribution (loader writes land in the same bucket
  // as the entry's handler pushes — shortCode is in matched/segmentOrder, so
  // collectHandleData keeps them; an id outside the order is silently
  // dropped). Loaders resolve BEFORE the handler-resolution sites assign
  // this (handler-first ordering), so without the pin the captured value is
  // a stale sibling's id (document lane) or undefined (navigation lane —
  // pushes silently vanished).
  (ctx as InternalHandlerContext<any, TEnv>)._currentSegmentId = shortCode;

  const matchedIds: string[] = [];
  for (let i = 0; i < loaderEntries.length; i++) {
    matchedIds.push(`${shortCode}D${i}.${loaderEntries[i]!.loader.$$id}`);
  }

  // FRESH: every loader is new; no decision is asked, traced or observed.
  const toRun = fresh
    ? undefined
    : await loadersToRerun(pass, owner, belongsToRoute, matchedIds);

  // Error context for wrapLoaderPromise: without it, a throwing DSL loader never
  // fires createRouter({ onError }) (phase "loader") nor emits the loader.error
  // telemetry event. A partial pass reports with isPartial.
  const errorContext = fresh
    ? buildLoaderErrorContext(ctx)
    : { ...buildLoaderErrorContext(ctx), isPartial: true };

  // FRESH: awaitBeforeFlush (loader(Def, { ssr: false })). A document render
  // awaits these loaders before returning, so their data is settled, their
  // handle pushes beat the barrier snapshot, and a thrown notFound()'s status
  // write deterministically precedes Response construction. The ids must
  // register on the request context BEFORE kickoff — rendered() checks the
  // set to fail fast on the barrier cycle (segment resolution awaits the
  // loader, the barrier awaits segment resolution, rendered() awaits the
  // barrier), and the loader body can call rendered() before the await below
  // is reached. Shell-capture renders await too: flagged loaders execute at
  // capture (lane rule: see resolveLoaderData, loader-cache.ts), so their
  // handle pushes must land in the prelude. A navigation evaluation never
  // carries awaitBeforeFlush.
  const awaitedIndices = fresh
    ? registerAwaitBeforeFlushIds(loaderEntries)
    : [];

  // PPR bake/seed key (lane rule: see resolveLoaderData, loader-cache.ts).
  // The key must thread through EVERY resolveLoaderData funnel — omitting it
  // made a capture-active context whole-container-mask every loader on the
  // partial path (a never-settling promise for a loader that should have
  // executed). Outside capture the key only activates the _shellLoaderSeed
  // overlay, which serveShellHit seeds for a document HIT and the PPR
  // partial replay (matchPartialWithPprReplay) seeds once its doc record hits.
  const bakeLane = owner.bakeLane;

  const kickoff = (
    loaderEntry: LoaderEntry,
    segmentId: string,
  ): Promise<unknown> =>
    runInsideLoaderScope(
      () =>
        resolveLoaderData(
          loaderEntry,
          ctx,
          ctx.pathname,
          // The bake key rides for flagged loaders too (`bake`): ssr: false
          // bakes at capture regardless of the entry's loading() lane
          // (loader-cache.ts capture branch), its HIT-tail seed overlay needs
          // the same key, and on a navigation it pins exactly as on the
          // document HIT.
          bakeLane || loaderEntry.bake === true ? segmentId : null,
        ),
      loaderEntry.loader.$$id,
      loaderEntry.reverseScope,
    );
  // The wrapped promise is contracted to never reject (wrapLoaderPromise): a
  // failed loader resolves with its error envelope and renders its own
  // per-loader boundary.
  const start = (loaderEntry: LoaderEntry, segmentId: string) =>
    pass.deps.wrapLoaderPromise(
      kickoff(loaderEntry, segmentId),
      owner.boundary,
      segmentId,
      ctx.pathname,
      errorContext,
      // FRESH: a flagged loader's failure falls back to the default boundary.
      fresh ? loaderEntry.awaitBeforeFlush : undefined,
    );

  const segments: ResolvedSegment[] = [];
  const count = toRun === undefined ? loaderEntries.length : toRun.length;
  for (let k = 0; k < count; k++) {
    const index = toRun === undefined ? k : toRun[k]!;
    const loaderEntry = loaderEntries[index]!;
    const segmentId = matchedIds[index]!;
    const { loader } = loaderEntry;
    // Only a loader on a segment the client lacks (defersLoader). It
    // would have run. Registered, not started: it runs, and reads its
    // cache(), only if a reader starts it (startDeferredLoader).
    if (defersLoader(ctx, loaderEntry, segmentId)) {
      registerDeferredLoader(ctx, loader.$$id, shortCode, () =>
        kickoff(loaderEntry, segmentId),
      );
      const deferred: ResolvedSegment = {
        id: segmentId,
        namespace: owner.namespace,
        type: "loader",
        index,
        component: null,
        params: ctx.params,
        loaderId: loader.$$id,
        belongsToRoute,
        deferred: true,
      };
      deferredLoaderRuns.set(deferred, () => start(loaderEntry, segmentId));
      segments.push(deferred);
      continue;
    }
    segments.push({
      id: segmentId,
      namespace: owner.namespace,
      type: "loader",
      index,
      component: null,
      params: ctx.params,
      loaderId: loader.$$id,
      // FRESH, document AND capture renders: segment-system's value-delivery
      // await and the dev SSR-suspension diagnostic both key off it.
      ...(fresh ? stampAwaitBeforeFlush(loaderEntry) : undefined),
      loaderData: start(loaderEntry, segmentId),
      belongsToRoute,
    });
  }

  if (fresh) {
    // loading(false): every loader settles before the handler runs, so the
    // handler streams no loading placeholder. A PPR shell capture keeps the
    // streaming shape: it masks LIVE-lane loaders with never-resolving
    // promises (loader-mask.ts), and awaiting them would hang the capture
    // render's match() forever. The `loadingDisabled` short-circuit keeps the
    // ALS check off the hot path. Otherwise only the flagged loaders are
    // awaited; unflagged siblings keep streaming.
    const settled =
      owner.loadingDisabled && !isShellCaptureActive()
        ? segments
        : awaitedIndices.length > 0
          ? awaitedIndices.map((i) => segments[i]!)
          : undefined;
    if (settled !== undefined && settled.length > 0) {
      await Promise.all(settled.map((s) => s.loaderData));
    }
  }

  return { segments, matchedIds };
}

/**
 * Resolve only loader segments for all entries: a cache() or prerender HIT
 * serves the cached non-loader segments, and loaders are never cached.
 */
export async function resolveLoadersOnlyWithRevalidation<TEnv>(
  pass: ResolutionPass<TEnv>,
  entries: EntryData[],
): Promise<{ segments: ResolvedSegment[]; matchedIds: string[] }> {
  const allLoaderSegments: ResolvedSegment[] = [];
  const allMatchedIds: string[] = [];
  const seenIds = new Set<string>();

  // Loader-only serves still run loaders live — on a ppr route their header
  // writes are dead letters (headers flushed with the shell), so the guard
  // latches here too (see resolveAllSegmentsWithRevalidation). cache() needs
  // no latch: loader writes are exempt under cache()
  // (assertCachedHeaderWriteAllowed).
  latchPprHeaderScopeForEntries(entries, pass.routeKey);

  async function collectEntryLoaders(
    entry: EntryData,
    belongsToRoute: boolean,
    shortCodeOverride?: string,
  ): Promise<void> {
    // Skip if all loaders from this entry have already been resolved
    // via a parent (e.g., cache boundary wrapping a layout with shared loaders).
    const loaderEntries = entry.loader ?? [];
    const sc = shortCodeOverride ?? entry.shortCode;
    const allAlreadySeen =
      loaderEntries.length > 0 &&
      loaderEntries.every((le, i) =>
        seenIds.has(`${sc}D${i}.${le.loader.$$id}`),
      );
    if (!allAlreadySeen && ownsLoaders(pass, entry)) {
      const { segments, matchedIds } = await resolveOwnerLoaders(
        pass,
        ownerOf(entry, shortCodeOverride),
        belongsToRoute,
      );
      for (const seg of segments) {
        if (!seenIds.has(seg.id)) {
          seenIds.add(seg.id);
          allLoaderSegments.push(seg);
        }
      }
      allMatchedIds.push(...matchedIds);
    }

    const seenParallelEntryIds = new Set<string>();
    for (const parallelEntry of getParallelEntries(entry.parallel)) {
      if (seenParallelEntryIds.has(parallelEntry.id)) continue;
      seenParallelEntryIds.add(parallelEntry.id);
      await collectEntryLoaders(parallelEntry, belongsToRoute, entry.shortCode);
    }

    const childBelongsToRoute = belongsToRoute || entry.type === "route";
    for (const layoutEntry of entry.layout) {
      await collectEntryLoaders(layoutEntry, childBelongsToRoute);
      // Inherit route loaders for orphan layouts with parallels.
      // Resolve directly — do NOT re-enter collectEntryLoaders with the
      // route entry, as that would re-iterate route.layout and loop.
      if (
        entry.type === "route" &&
        entry.loader &&
        entry.loader.length > 0 &&
        Object.keys(layoutEntry.parallel).length > 0
      ) {
        const inherited = await resolveOwnerLoaders(
          pass,
          ownerOf(entry, layoutEntry.shortCode),
          childBelongsToRoute,
        );
        for (const seg of inherited.segments) {
          if (!seenIds.has(seg.id)) {
            seenIds.add(seg.id);
            seg._inherited = true;
            allLoaderSegments.push(seg);
          }
        }
        allMatchedIds.push(...inherited.matchedIds);
      }
    }
  }

  for (const entry of entries) {
    await collectEntryLoaders(entry, entry.type === "route");
  }

  deliverStartedLoaders(pass.context, allLoaderSegments);
  return { segments: allLoaderSegments, matchedIds: allMatchedIds };
}

/**
 * Build a map of segment shortCode -> entry with revalidate functions.
 */
export function buildEntryRevalidateMap(
  entries: EntryData[],
): Map<
  string,
  { entry: EntryData; revalidate: ShouldRevalidateFn<any, any>[] }
> {
  const map = new Map<
    string,
    { entry: EntryData; revalidate: ShouldRevalidateFn<any, any>[] }
  >();

  function processEntry(entry: EntryData, parentShortCode?: string) {
    map.set(entry.shortCode, { entry, revalidate: entry.revalidate });

    if (entry.type !== "parallel") {
      for (const { slot, entry: parallelEntry } of getParallelSlotEntries(
        entry.parallel,
      )) {
        const parallelParentShortCode = parentShortCode ?? entry.shortCode;
        const parallelId = `${parallelParentShortCode}.${slot}`;
        map.set(parallelId, {
          entry: parallelEntry,
          revalidate: parallelEntry.revalidate,
        });
      }
    }

    for (const layoutEntry of entry.layout) {
      processEntry(layoutEntry, entry.shortCode);
    }
  }

  for (const entry of entries) {
    processEntry(entry);
  }

  return map;
}

/**
 * Resolve the component for a single parallel slot. Pure component resolution
 * shared by the main path and the orphan path of
 * resolveParallelSegmentsWithRevalidation: try the static slot cache, else run
 * the slot handler (pinning _currentSegmentId to the slot id so handle pushes
 * land in the slot's own bucket, and wrapping a streamed handler). Returns the
 * resolved component and whether the handler actually ran, or undefined when
 * there is nothing to render: the handler was evicted (production static
 * slot) and the static lookup missed. Does NOT touch the revalidate-default
 * policy (the caller decides shouldResolve, including the orphan-vs-main
 * defaultOverride divergence) or loader-resolution ordering.
 */
async function resolveParallelSlotComponent<TEnv>(
  pass: ResolutionPass<TEnv>,
  args: {
    shouldResolve: boolean;
    parallelEntry: ParallelEntryData;
    slot: string;
    parallelId: string;
    handler:
      | ((ctx: HandlerContext<any, TEnv>) => ReactNode | Promise<ReactNode>)
      | ReactNode
      | undefined;
    /** Matched chain entry (where the sync path catches), else the slot's owner. */
    boundaryEntry: EntryData;
  },
): Promise<
  { component: ReactNode | undefined; handlerRan: boolean } | undefined
> {
  const {
    shouldResolve,
    parallelEntry,
    slot,
    parallelId,
    handler,
    boundaryEntry,
  } = args;
  const { context, deps, routeKey, params } = pass;
  const fresh = pass.client === FRESH;

  let component: ReactNode | undefined;
  let handlerRan = false;
  if (shouldResolve) {
    component = await tryStaticSlot(parallelEntry, slot, parallelId);
    // tryStaticSlot returning a value means the static cache supplied the
    // component — handler did NOT run. handlerRan stays false.
  }
  if (component === undefined) {
    const hasLoadingFallback =
      parallelEntry.loading !== undefined && parallelEntry.loading !== false;
    if (!shouldResolve) {
      component = null;
    } else if (handler === undefined) {
      return undefined;
    } else {
      // Slot-keyed pushes — slot owns its own bucket, parent layout owns its
      // own. On slot-only revalidations the partial merge updates only the
      // slot's bucket; the parent's bucket stays intact.
      (context as InternalHandlerContext<any, TEnv>)._currentSegmentId =
        parallelId;
      handlerRan = true;
      const slotContext = withReverseScope(
        hasLoadingFallback ? withSegmentPin(context) : context,
        parallelEntry.reverseScope,
      );
      // FRESH meters the slot handler (its perf metric) and runs it inside its
      // rango.handler span; a partial pass runs it in the slot's tag scope.
      const doneHandler = fresh
        ? track(`handler:${parallelEntry.id}.${slot}`, 2)
        : undefined;
      const run = () =>
        typeof handler !== "function"
          ? handler
          : fresh
            ? observeSegmentHandler(
                parallelId,
                `${parallelEntry.id}.${slot}`,
                handler,
                slotContext,
              )
            : runInSegmentTagScope(parallelId, handler, slotContext);
      if (hasLoadingFallback) {
        const result = run();
        if (result instanceof Promise) {
          // FRESH: no streamed-Response warning for a slot.
          if (!fresh) warnOnStreamedResponse(result, parallelId);
          if (doneHandler) result.finally(doneHandler).catch(() => {});
          component = trackStreamedHandler(deps, result, {
            boundaryEntry,
            segmentId: parallelId,
            segmentType: "parallel",
            context,
            routeKey,
            params,
            recover: !pass.throwOnError,
          });
        } else {
          doneHandler?.();
          component = result as ReactNode;
        }
      } else {
        // A static value (a Promise included) goes to render as is.
        component = typeof handler === "function" ? await run() : handler;
        doneHandler?.();
      }
    }
  }

  return { component, handlerRan };
}

/**
 * Resolve parallel segments with revalidation.
 */
export async function resolveParallelSegmentsWithRevalidation<TEnv>(
  pass: ResolutionPass<TEnv>,
  entry: EntryData,
  belongsToRoute: boolean,
  options?: {
    /**
     * Seed for an unknown parent-chain slot (slot not in clientSegmentIds) when
     * there are no deciding revalidate fns. "type-derived" (default, main path):
     * `belongsToRoute || isNewParent`. "force-render" (orphan path): always
     * `true` — orphan parallels always belong to the route and must render
     * unless the user opts out via revalidate(); the #482 blank-parent-chain-
     * slot guard.
     */
    parentChainDefault?: "type-derived" | "force-render";
    /**
     * When a slot's loaders are resolved relative to the slot segment push.
     * "after" (default, main path) pushes the slot segment first; "before"
     * (orphan path) resolves loaders first. This only changes the
     * segments/matchedIds emission ORDER (the client reconciler is insensitive
     * to it: loader sub-ids are filtered out and slots are re-grouped by parent).
     */
    loaderOrder?: "after" | "before";
    /**
     * The matched chain entry being resolved: where the sync path catches a
     * handler error, so a streamed slot handler (or a slot owned by a
     * routeless layout) recovers into the same boundary. Defaults to `entry`.
     */
    boundaryEntry?: EntryData;
  },
): Promise<SegmentRevalidationResult> {
  const { context, client: clientSegmentIds, params, routeKey } = pass;
  const fresh = clientSegmentIds === FRESH;
  const segments: ResolvedSegment[] = [];
  const matchedIds: string[] = [];
  const parentChainDefault = options?.parentChainDefault ?? "type-derived";
  const loaderOrder = options?.loaderOrder ?? "after";

  const resolvedParallelEntries = new Set<string>();
  for (const { slot, entry: parallelEntry } of getParallelSlotEntries(
    entry.parallel,
  )) {
    invariant(
      parallelEntry.type === "parallel",
      `Expected parallel entry, got: ${parallelEntry.type}`,
    );

    const slots = parallelEntry.handler as Record<
      `@${string}`,
      | ((ctx: HandlerContext<any, TEnv>) => ReactNode | Promise<ReactNode>)
      | ReactNode
    >;
    // In production, static handler bodies are evicted and the slot value
    // may be undefined. The static store holds the pre-rendered component.
    // We defer the handler check until after tryStaticSlot.
    const handler = slots[slot];

    const parallelId = `${entry.shortCode}.${slot}`;

    const isFullRefetch = clientSegmentIds.size === 0;
    const isNewParent = !clientSegmentIds.has(entry.shortCode);

    // A slot's loaders (never cached) are deduped per parallel entry and
    // emitted either before or after the slot segment per loaderOrder.
    const resolveSlotLoaders =
      resolvedParallelEntries.has(parallelEntry.id) ||
      !ownsLoaders(pass, parallelEntry)
        ? undefined
        : async () => {
            const loaderResult = await resolveOwnerLoaders(
              pass,
              ownerOf(parallelEntry, entry.shortCode),
              belongsToRoute,
            );
            // FRESH tags a slot's loaders with the slot's loading(), so
            // renderSegments streams them under it instead of awaiting them
            // on the layout. A partial pass's are tagged on render
            // (restoreParallelLoaderMarkers, segment-system.tsx).
            if (fresh && parallelEntry.loading) {
              for (const seg of loaderResult.segments) {
                seg.parallelLoading = parallelEntry.loading;
              }
            }
            segments.push(...loaderResult.segments);
            matchedIds.push(...loaderResult.matchedIds);
            resolvedParallelEntries.add(parallelEntry.id);
          };

    if (resolveSlotLoaders && loaderOrder === "before") {
      await resolveSlotLoaders();
    }
    // Always announce the slot in matchedIds — it's unconditionally appended
    // to `segments` below, and a segment present in segments but missing from
    // matched lets the client prune it (then it's missing from clientSegmentIds
    // on the next request, perpetuating the staleness).
    matchedIds.push(parallelId);

    // A slot below a unit a prefetch skipped goes with it, and no predicate
    // runs: a prefetch sends what the slot declares instead of running its
    // handler.
    let deferred = deferUnit(context, parallelId, "below");
    // A fill sends exactly the slots the client lacks, ahead of every rule
    // below (fillSends).
    const fill = fillSends(context, parallelId, clientSegmentIds);
    let shouldResolve: boolean;
    if (fresh) {
      // FRESH: the slot is new; no trace entry, no decision event.
      shouldResolve = true;
    } else if (fill !== undefined) {
      shouldResolve = fill;
    } else if (deferred) {
      shouldResolve = true;
    } else if (isFullRefetch) {
      // Client has nothing cached — slot MUST render. User revalidate fns are
      // bypassed here because returning false would leave the segment blank
      // with no client-side fallback.
      traceFullRefetchedParallelSlot(parallelId, belongsToRoute);
      shouldResolve = true;
    } else {
      // For non-empty client sets, consult user revalidate fns. When the slot
      // is unknown to the client, override the type-derived default so the
      // soft chain seeds with the right "new segment" / "parent-chain" value.
      //
      // A "new segment" seed is floored: the client has no cached copy of this
      // slot, so a user `false` would render component:null and leave it blank
      // rather than keep anything. Sibling resolvers (loaders, layout/route
      // entries, orphan layouts) get the same guarantee by short-circuiting
      // without consulting user fns at all; #482 made this path consult them so
      // a "skip-parent-chain" seed could still be raised, so floor instead of
      // short-circuiting — user fns run, and may only raise.
      let defaultOverride:
        | { value: boolean; reason: string; floor?: boolean }
        | undefined;
      if (!clientSegmentIds.has(parallelId)) {
        const value =
          parentChainDefault === "force-render"
            ? true
            : belongsToRoute || isNewParent;
        defaultOverride = {
          value,
          reason: value ? "new-segment" : "skip-parent-chain",
          floor: value,
        };
      }

      const dummySegment: ResolvedSegment = {
        id: parallelId,
        namespace: parallelEntry.id,
        type: "parallel",
        index: 0,
        component: null as any,
        params,
        slot,
        belongsToRoute,
        parallelName: `${parallelEntry.id}.${slot}`,
        ...(parallelEntry.mountPath
          ? { mountPath: parallelEntry.mountPath }
          : {}),
      };

      shouldResolve = await evaluateRevalidation({
        ...revalidationInputOf(pass),
        segment: dummySegment,
        revalidations: parallelEntry.revalidate.map((fn, i) => ({
          name: `revalidate${i}`,
          fn,
        })),
        traceSource: "parallel",
        defaultOverride,
      });
    }
    if (!fresh) {
      emitRevalidationDecision(
        parallelId,
        context.pathname,
        routeKey,
        shouldResolve,
      );
    }

    // A slot with its own flagged loading() is its own unit.
    if (shouldResolve) deferred ??= deferUnit(context, parallelId, "slot");
    const resolved = deferred
      ? { component: null, handlerRan: false }
      : await resolveParallelSlotComponent(pass, {
          shouldResolve,
          parallelEntry,
          slot,
          parallelId,
          handler,
          boundaryEntry: options?.boundaryEntry ?? entry,
        });
    if (resolved === undefined && fresh) {
      // FRESH: an evicted slot handler whose static lookup missed renders no
      // slot segment; its loaders still resolve.
      if (resolveSlotLoaders && loaderOrder === "after") {
        await resolveSlotLoaders();
      }
      continue;
    }
    // Nothing to render on a partial pass: null, so the client keeps its
    // cached version.
    const { component, handlerRan } = resolved ?? {
      component: null,
      handlerRan: false,
    };

    segments.push({
      id: parallelId,
      namespace: parallelEntry.id,
      type: "parallel",
      index: 0,
      component,
      loading: parallelEntry.loading === false ? null : parallelEntry.loading,
      transition: applyViewTransitionDefault(
        parallelEntry.transition,
        pass.deps.viewTransitionDefault,
      ),
      params,
      slot,
      _handlerRan: handlerRan,
      belongsToRoute,
      parallelName: `${parallelEntry.id}.${slot}`,
      ...(parallelEntry.mountPath
        ? { mountPath: parallelEntry.mountPath }
        : {}),
      ...deferred,
    });

    if (resolveSlotLoaders && loaderOrder === "after") {
      await resolveSlotLoaders();
    }
  }

  return { segments, matchedIds };
}

/**
 * Whether a partial pass re-renders a chain entry: one the client lacks, or a
 * held one whose revalidate() rules ask for it (revalidateHeld).
 */
async function entryRevalidates<TEnv>(
  pass: ResolutionPass<TEnv>,
  entry: Exclude<EntryData, { type: "parallel" }>,
  belongsToRoute: boolean,
): Promise<boolean> {
  const { context, params, routeKey } = pass;
  const hasSegment = pass.client.has(entry.shortCode);
  debugLog("segment.revalidate", "entry presence check", {
    segmentId: entry.shortCode,
    entryType: entry.type,
    clientHasSegment: hasSegment,
    belongsToRoute,
  });
  if (!hasSegment) {
    if (isTraceActive()) {
      const segType =
        entry.type === "cache" ? "layout" : (entry.type as "layout" | "route");
      pushRevalidationTraceEntry({
        segmentId: entry.shortCode,
        segmentType: segType,
        belongsToRoute,
        source: "segment-resolution",
        defaultShouldRevalidate: true,
        finalShouldRevalidate: true,
        reason: "new-segment",
      });
    }
    return true;
  }

  const dummySegment: ResolvedSegment = {
    id: entry.shortCode,
    namespace: entry.id,
    type:
      entry.type === "cache" ? "layout" : (entry.type as "layout" | "route"),
    index: 0,
    component: null as any,
    params,
    belongsToRoute,
    ...(entry.type === "layout" || entry.type === "cache"
      ? { layoutName: entry.id }
      : {}),
    ...(entry.mountPath ? { mountPath: entry.mountPath } : {}),
  };

  return revalidateHeld(pass, {
    segment: dummySegment,
    revalidations: entry.revalidate.map((fn, i) => ({
      name: `revalidate${i}`,
      fn,
    })),
    traceSource: entry.type === "route" ? "route-handler" : "layout-handler",
    onEvaluated: (shouldRevalidate) => {
      emitRevalidationDecision(
        entry.shortCode,
        context.pathname,
        routeKey,
        shouldRevalidate,
      );
      debugLog("segment.revalidate", "entry revalidation decision", {
        segmentId: entry.shortCode,
        shouldRevalidate,
      });
    },
  });
}

/**
 * Run a route entry's handler: a static store hit, else the handler, streamed
 * under the route's loading() unless an action awaits it.
 */
async function resolveRouteComponent<TEnv>(
  pass: ResolutionPass<TEnv>,
  entry: Extract<EntryData, { type: "route" }>,
  fresh: boolean,
): Promise<ReactNode | { content: ReactNode }> {
  const { context, params, routeKey, actionContext } = pass;
  // A partial pass meters a static hit as a handler run; FRESH meters a
  // route's handler only when it runs.
  let doneHandler = fresh ? undefined : track(`handler:${entry.id}`, 2);
  const staticComponent = await tryStaticHandler(entry, entry.shortCode);
  if (staticComponent !== undefined) {
    doneHandler?.();
    return staticComponent;
  }
  doneHandler ??= track(`handler:${entry.id}`, 2);
  // For Passthrough routes at runtime, use the live handler instead of
  // the build handler. At build time (context.build === true), always
  // use the build handler from entry.handler.
  const handler =
    !context.build && entry.liveHandler ? entry.liveHandler : entry.handler;
  if (!entry.loading) {
    const result = handleHandlerResult(
      await observeSegmentHandler(entry.shortCode, entry.id, handler, context),
    );
    doneHandler();
    return result;
  }
  if (!actionContext) {
    const result = handleHandlerResult(
      observeSegmentHandler(
        entry.shortCode,
        entry.id,
        handler,
        withSegmentPin(context),
      ),
    );
    if (result instanceof Promise) {
      warnOnStreamedResponse(result, entry.id);
      result.finally(doneHandler).catch(() => {});
      return {
        content: trackStreamedHandler(pass.deps, result, {
          boundaryEntry: entry,
          segmentId: entry.shortCode,
          segmentType: entry.type,
          context,
          routeKey,
          params,
          recover: !pass.throwOnError,
        }),
      };
    }
    doneHandler();
    return { content: result };
  }
  debugLog("segment.action", "resolving action route with awaited value", {
    entryId: entry.id,
  });
  const actionResult = handleHandlerResult(
    await observeSegmentHandler(entry.shortCode, entry.id, handler, context),
  );
  doneHandler();
  return {
    content: Promise.resolve(actionResult),
  };
}

/**
 * Resolve entry handler (layout, cache, or route) with revalidation.
 */
export async function resolveEntryHandlerWithRevalidation<TEnv>(
  pass: ResolutionPass<TEnv>,
  entry: Exclude<EntryData, { type: "parallel" }>,
  belongsToRoute: boolean,
): Promise<{ segment: ResolvedSegment; matchedId: string }> {
  const { context, params } = pass;
  const fresh = pass.client === FRESH;
  const matchedId = entry.shortCode;

  let handlerRan = false;
  let deferred: { readonly deferred: true } | undefined;
  let component: ReactNode | { content: ReactNode } = null;
  // FRESH: the entry is new; no decision is asked, traced or observed.
  if (fresh || (await entryRevalidates(pass, entry, belongsToRoute))) {
    // Only an entry the client lacks (defersUnit). Its handler would
    // have run, and a prefetch sends the entry's fallback in its place.
    deferred = deferUnit(context, entry.shortCode, "chain");
    if (!deferred) {
      handlerRan = true;
      (context as InternalHandlerContext<any, TEnv>)._currentSegmentId =
        entry.shortCode;
      if (entry.type === "route") {
        component = await resolveRouteComponent(pass, entry, fresh);
      } else {
        const doneHandler = track(`handler:${entry.id}`, 2);
        component = await resolveLayoutComponent(entry, context);
        doneHandler();
      }
    }
  }

  // Normalize void handlers (undefined) to null so the reconciler's
  // component === null checks work consistently for both void and explicit
  // null. FRESH keeps a void layout's undefined: cache-scope.ts refuses a
  // document record whose layout component is null.
  const resolvedComponent =
    component && typeof component === "object" && "content" in component
      ? ((component as { content: ReactNode }).content ?? null)
      : fresh && entry.type !== "route"
        ? (component as ReactNode)
        : (component ?? null);

  const segment: ResolvedSegment = {
    id: entry.shortCode,
    namespace: entry.id,
    type:
      entry.type === "cache" ? "layout" : (entry.type as "layout" | "route"),
    index: 0,
    component: resolvedComponent,
    loading: entry.loading === false ? null : entry.loading,
    transition: applyViewTransitionDefault(
      entry.transition,
      pass.deps.viewTransitionDefault,
    ),
    params,
    belongsToRoute,
  };
  // Assigned, not spread: a conditional spread costs a temporary object and a
  // property copy on every chain entry. The keys keep this order.
  if (entry.clientGroup) segment.clientGroup = entry.clientGroup;
  if (entry.type === "layout" || entry.type === "cache") {
    segment.layoutName = entry.id;
  }
  if (entry.mountPath) segment.mountPath = entry.mountPath;
  segment._handlerRan = handlerRan;
  if (deferred) segment.deferred = deferred.deferred;

  return { segment, matchedId };
}

/**
 * Resolve one chain entry's segments: its loaders, its handler, its orphan
 * layouts and its parallels, handler first.
 */
export async function resolveSegmentWithRevalidation<TEnv>(
  pass: ResolutionPass<TEnv>,
  entry: Exclude<EntryData, { type: "parallel" }>,
  /** The matched route's full chain; see RevalidatingWalkOptions.chain. */
  chain?: readonly EntryData[],
): Promise<SegmentRevalidationResult> {
  const segments: ResolvedSegment[] = [];
  const matchedIds: string[] = [];

  const belongsToRoute = entry.type === "route";

  if (ownsLoaders(pass, entry)) {
    const loaderResult = await resolveOwnerLoaders(
      pass,
      ownerOf(entry),
      belongsToRoute,
    );
    segments.push(...loaderResult.segments);
    matchedIds.push(...loaderResult.matchedIds);
  }

  // For route entries, execute the handler BEFORE orphan layouts and parallels
  // so ctx.set() data is available to them via ctx.get(). The handler's
  // segment is pushed after children to preserve tree composition order.
  let routeHandlerResult:
    | { segment: ResolvedSegment; matchedId: string }
    | undefined;
  if (entry.type === "route") {
    routeHandlerResult = await resolveEntryHandlerWithRevalidation(
      pass,
      entry,
      belongsToRoute,
    );

    for (const orphan of entry.layout) {
      const orphanResult = await resolveOrphanLayoutWithRevalidation(
        pass,
        orphan,
        true,
        entry,
      );
      segments.push(...orphanResult.segments);
      matchedIds.push(...orphanResult.matchedIds);
    }
  }

  const slotted = declaresSlot(entry.parallel);

  if (routeHandlerResult) {
    // Route entry: handler already executed above; resolve parallels
    // (handler data visible) then push handler segment last for tree order.
    if (slotted) {
      const parallelResult = await resolveParallelSegmentsWithRevalidation(
        pass,
        entry,
        belongsToRoute,
      );
      segments.push(...parallelResult.segments);
      matchedIds.push(...parallelResult.matchedIds);
    }

    segments.push(routeHandlerResult.segment);
    matchedIds.push(routeHandlerResult.matchedId);
  } else {
    // Layout/cache entry: handler-first — resolve handler before parallels
    // so ctx.set() values are visible to parallel children.
    const handlerResult = await resolveEntryHandlerWithRevalidation(
      pass,
      entry,
      belongsToRoute,
    );
    segments.push(handlerResult.segment);
    matchedIds.push(handlerResult.matchedId);

    if (slotted) {
      const parallelResult = await resolveParallelSegmentsWithRevalidation(
        pass,
        entry,
        belongsToRoute,
      );
      segments.push(...parallelResult.segments);
      matchedIds.push(...parallelResult.matchedIds);
    }

    for (const orphan of entry.layout) {
      if (chain?.includes(orphan)) continue;
      const orphanResult = await resolveOrphanLayoutWithRevalidation(
        pass,
        orphan,
        false,
        undefined,
        entry,
      );
      segments.push(...orphanResult.segments);
      matchedIds.push(...orphanResult.matchedIds);
    }
  }

  return { segments, matchedIds };
}

/**
 * Whether a partial pass re-renders an orphan layout: one the client lacks,
 * or a held one whose revalidate() rules ask for it (revalidateHeld).
 */
async function orphanRevalidates<TEnv>(
  pass: ResolutionPass<TEnv>,
  orphan: EntryData,
  belongsToRoute: boolean,
): Promise<boolean> {
  const { context, params, routeKey } = pass;
  if (!pass.client.has(orphan.shortCode)) {
    if (isTraceActive()) {
      pushRevalidationTraceEntry({
        segmentId: orphan.shortCode,
        segmentType: "layout",
        belongsToRoute,
        source: "orphan-layout",
        defaultShouldRevalidate: true,
        finalShouldRevalidate: true,
        reason: "new-segment",
      });
    }
    return true;
  }

  const dummySegment: ResolvedSegment = {
    id: orphan.shortCode,
    namespace: orphan.id,
    type: "layout",
    index: 0,
    component: null as any,
    params,
    belongsToRoute,
    layoutName: orphan.id,
    ...(orphan.mountPath ? { mountPath: orphan.mountPath } : {}),
  };

  return revalidateHeld(pass, {
    segment: dummySegment,
    revalidations: orphan.revalidate.map((fn, i) => ({
      name: `revalidate${i}`,
      fn,
    })),
    traceSource: "orphan-layout",
    onEvaluated: (shouldRevalidate) =>
      emitRevalidationDecision(
        orphan.shortCode,
        context.pathname,
        routeKey,
        shouldRevalidate,
      ),
  });
}

/**
 * Resolve orphan layout with revalidation.
 */
export async function resolveOrphanLayoutWithRevalidation<TEnv>(
  pass: ResolutionPass<TEnv>,
  orphan: EntryData,
  belongsToRoute: boolean,
  /** Parent route entry — its loaders are inherited so parallel slots can access them. */
  parentRouteEntry?: EntryData,
  /**
   * Matched chain entry being resolved (see
   * resolveParallelSegmentsWithRevalidation's boundaryEntry); defaults to
   * parentRouteEntry.
   */
  boundaryEntry: EntryData | undefined = parentRouteEntry,
): Promise<SegmentRevalidationResult> {
  invariant(
    orphan.type === "layout" || orphan.type === "cache",
    `Expected orphan to be a layout or cache, got: ${orphan.type}`,
  );

  const { context, params } = pass;
  const fresh = pass.client === FRESH;
  const segments: ResolvedSegment[] = [];
  const matchedIds: string[] = [];

  if (ownsLoaders(pass, orphan)) {
    const loaderResult = await resolveOwnerLoaders(
      pass,
      ownerOf(orphan),
      belongsToRoute,
    );
    segments.push(...loaderResult.segments);
    matchedIds.push(...loaderResult.matchedIds);
  }

  // Inherit parent route's loaders so parallel slots inside this layout
  // can access them via useLoader(). Without this, the route's loaders are
  // only in the route's OutletProvider (rendered as <Outlet /> content),
  // which is a child — not a parent — of the layout's context.
  if (
    parentRouteEntry &&
    parentRouteEntry.loader &&
    parentRouteEntry.loader.length > 0 &&
    Object.keys(orphan.parallel).length > 0
  ) {
    const inheritedResult = await resolveOwnerLoaders(
      pass,
      ownerOf(parentRouteEntry, orphan.shortCode),
      belongsToRoute,
    );
    // Tag as inherited so buildMatchResult can deduplicate when safe
    for (const s of inheritedResult.segments) {
      s._inherited = true;
    }
    segments.push(...inheritedResult.segments);
    matchedIds.push(...inheritedResult.matchedIds);
  }

  // Handler-first: resolve orphan layout handler before its parallels
  // so ctx.set() values are visible to parallel children.
  matchedIds.push(orphan.shortCode);

  let deferred: { readonly deferred: true } | undefined;
  let component: ReactNode = null;
  // FRESH: the orphan is new; no decision is asked, traced or observed.
  if (fresh || (await orphanRevalidates(pass, orphan, belongsToRoute))) {
    // Below a unit a prefetch skipped: the orphan goes with it.
    deferred = deferUnit(context, orphan.shortCode, "below");
    if (!deferred) {
      if (!fresh) {
        component = await resolveLayoutComponent(orphan, context);
      } else {
        // FRESH meters the orphan's handler; a partial pass does not.
        const doneHandler = track(`handler:${orphan.id}`, 2);
        component = await resolveLayoutComponent(orphan, context);
        doneHandler();
      }
    }
  }

  segments.push({
    id: orphan.shortCode,
    namespace: orphan.id,
    type: "layout",
    index: 0,
    component,
    params,
    belongsToRoute,
    layoutName: orphan.id,
    loading: orphan.loading === false ? null : orphan.loading,
    transition: applyViewTransitionDefault(
      orphan.transition,
      pass.deps.viewTransitionDefault,
    ),
    ...(orphan.mountPath ? { mountPath: orphan.mountPath } : {}),
    ...deferred,
  });

  // Resolve the orphan layout's parallel slots through the shared main-path
  // helper. The orphan policy is carried by explicit args, byte-for-byte:
  //   - parentChainDefault "force-render": an unknown parent-chain slot seeds
  //     `true` (orphan parallels always belong to the route — the #482 guard),
  //     where the main path would seed `belongsToRoute || isNewParent`.
  //   - loaderOrder "before": a slot's loaders are emitted before the slot
  //     segment, matching the prior inlined order. FRESH emits them after it,
  //     as on the main path.
  // `entry.shortCode` inside the helper is `orphan.shortCode` (orphan is passed
  // as `entry`), so the parallel ids + loader shortCodeOverride are unchanged.
  if (declaresSlot(orphan.parallel)) {
    const parallelResult = await resolveParallelSegmentsWithRevalidation(
      pass,
      orphan,
      belongsToRoute,
      {
        parentChainDefault: "force-render",
        loaderOrder: fresh ? "after" : "before",
        boundaryEntry,
      },
    );
    segments.push(...parallelResult.segments);
    matchedIds.push(...parallelResult.matchedIds);
  }

  // Routeless entries nested in this one (a layout() after a bare cache()
  // marker, a wrapper inside a routeless wrapper) wrap the same content one
  // level deeper. Issue #918: they were never rendered. None is in the
  // matched chain: that would put this orphan in it, and
  // resolveSegmentWithRevalidation skips those.
  for (const nested of orphan.layout) {
    const nestedResult = await resolveOrphanLayoutWithRevalidation(
      pass,
      nested,
      belongsToRoute,
      undefined,
      boundaryEntry,
    );
    segments.push(...nestedResult.segments);
    matchedIds.push(...nestedResult.matchedIds);
  }

  return { segments, matchedIds };
}

/** What resolveAllSegmentsWithRevalidation needs beyond its pass. */
export interface RevalidatingWalkOptions {
  /**
   * The intercept the request resolves: the route's entry (its handler and
   * loaders) is skipped and only its id is matched. None on a FRESH pass.
   */
  readonly interceptResult?: InterceptResult | null;
  /** For the intercept skip's debug log. */
  readonly localRouteName?: string;
  /** Where an entry's error boundary reports (resolveWithErrorBoundary). */
  readonly pathname: string;
  /**
   * The matched route's full entry chain. Defaults to `entries`;
   * withCacheLookup passes it when it resolves only the entries above a
   * cache() boundary. An orphan list can hold an entry of the chain: a bare
   * cache() marker sits in its layout's layout[] (it wraps that layout's
   * routes) and is the parent of the routes after it. For those routes it
   * resolves once, as a chain entry, below the cache() header latch (issue
   * #918: resolved twice on a MISS, once and discarded on a HIT).
   */
  readonly chain?: readonly EntryData[];
}

/** An entry's error or not-found segment, as its whole result. */
function boundaryResult(seg: ResolvedSegment): SegmentRevalidationResult {
  return { segments: [seg], matchedIds: [seg.id] };
}

/**
 * Resolve all segments for a route: a partial match (matchPartial), or a
 * full match with a FRESH pass.
 */
export async function resolveAllSegmentsWithRevalidation<TEnv>(
  pass: ResolutionPass<TEnv>,
  entries: EntryData[],
  walk: RevalidatingWalkOptions,
): Promise<{ segments: ResolvedSegment[]; matchedIds: string[] }> {
  const { context, params, routeKey, request } = pass;
  const { interceptResult, localRouteName, pathname } = walk;
  const chain = walk.chain ?? entries;
  const allSegments: ResolvedSegment[] = [];
  const matchedIds: string[] = [];
  const seenSegIds = new Set<string>();
  const seenMatchIds = new Set<string>();

  // ppr routes are document-scoped cached territory: the whole chain (root
  // layout down to the page) bakes into the shared shell, so the header-write
  // guard latches BEFORE any entry resolves (unlike the positional cache()
  // latch below). See assertCachedHeaderWriteAllowed (server/context.ts).
  latchPprHeaderScopeForEntries(entries, routeKey);

  // No router context at build time (prerender-match.ts): no telemetry sink.
  let telemetry;
  try {
    telemetry = getRouterContext()?.telemetry;
  } catch {}
  // FRESH: a full match reports an entry's error without isPartial, and a
  // build-time pass rethrows it (throwOnError).
  const report = {
    request,
    url: context.url,
    routeKey,
    isPartial: pass.client === FRESH ? undefined : true,
    telemetry,
  };
  const fillMatch = {
    handlerContext: context,
    isIntercept: !!interceptResult,
    clientSegmentSet: pass.client,
  };

  for (const entry of entries) {
    if (entry.type === "route" && interceptResult) {
      debugLog(
        "matchPartial.intercept",
        "skipping route handler during intercept",
        {
          localRouteName,
          segmentId: entry.shortCode,
        },
      );
      if (!seenMatchIds.has(entry.shortCode)) {
        seenMatchIds.add(entry.shortCode);
        matchedIds.push(entry.shortCode);
      }
      continue;
    }
    if (interceptFillSkips(fillMatch, entry.shortCode)) continue;

    const nonParallelEntry = entry as Exclude<EntryData, { type: "parallel" }>;
    // Set ALS flag when entering a cache() boundary so that ctx.get()
    // can guard non-cacheable variable reads. Also latch the header-write
    // scope (response-level side effects — headers/cookies/status).
    // Persists for all descendant entries. A route entry carries `cache` when
    // cache() is among its own children (dsl-helpers.ts cache()).
    if (entry.cache) {
      const store = RangoContext.getStore();
      if (store) store.insideCacheScope = true;
      latchCachedHeaderScope("cache", routeKey);
    }
    const doneEntry = track(`segment:${entry.id}`, 1);
    const resolved = await resolveWithErrorBoundary(
      nonParallelEntry,
      params,
      () => resolveSegmentWithRevalidation(pass, nonParallelEntry, chain),
      boundaryResult,
      pass.deps,
      report,
      pathname,
      pass.throwOnError,
    );
    doneEntry();

    // Deduplicate segments and matchedIds by ID. include() scopes can produce
    // entries that resolve the same shared layout/loader segment. Duplicates
    // in the segment array propagate to the client's matched[] and change
    // the React tree depth.
    for (const seg of resolved.segments) {
      if (!seenSegIds.has(seg.id)) {
        seenSegIds.add(seg.id);
        allSegments.push(seg);
      }
    }
    for (const id of resolved.matchedIds) {
      if (!seenMatchIds.has(id)) {
        seenMatchIds.add(id);
        matchedIds.push(id);
      }
    }
  }

  deliverStartedLoaders(context, allSegments);
  return { segments: allSegments, matchedIds };
}
