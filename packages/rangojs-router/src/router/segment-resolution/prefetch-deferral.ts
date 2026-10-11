/**
 * `prefetch: false`: what a prefetch request defers and what its fill request
 * runs (docs/design/prefetch-false.md).
 *
 * Two layers. The SCOPE is static per matched chain: which loader
 * registrations are deferrable and which entries can be a handler unit. The
 * PLAN is per match and rides the handler context
 * (InternalHandlerContext._prefetchDeferral): the request's mode and where the
 * chain's stored handler output starts. A request context cannot carry it: a
 * shell capture derives its context from the request that scheduled it and
 * would inherit a prefetch's mode.
 *
 * The decisions themselves are made in revalidation.ts, by asking this module.
 *
 * One rule runs through every decision: the flag applies only to a segment
 * the client does not have yet. A segment the client holds is never deferred,
 * whether or not it re-renders, and nothing is deferred because of it. A
 * placeholder over content that is on screen would replace it with a fallback,
 * or make the click wait where a plain navigation would not.
 *
 * "Holds" is what the request listed in `_rsc_segments` (PrefetchDeferral.held),
 * the set buildMatchResult (match-result.ts) filters the response with. Not
 * the set resolution works on: the match deletes a route's id from that one to
 * force a same-route render from an intercept source (match-api.ts), and a
 * unit deferred on that ground would be dropped from the response as held.
 */

import {
  getParallelEntries,
  getParallelSlotEntries,
  isPprEntry,
  type EntryData,
  type LoaderEntry,
} from "../../server/context.js";
import { requestHeaders } from "../../server/request-headers.js";
import type { HandlerContext, InternalHandlerContext } from "../../types.js";
import type { CacheScope } from "../../cache/cache-scope.js";
import { FILL_PARAM, PREFETCH_HEADER } from "../../prefetch-markers.js";

/**
 * What a request says it is, read once when its context is created
 * (RequestContext._requestKind). A fill is marked on the raw URL and wins
 * over the prefetch header. Whether a prefetch defers anything is decided per
 * match, by partialDeferralMode: a shell capture inherits the context of the
 * request that scheduled it and is never a prefetch.
 */
export function requestKind(
  request: Request,
  rawUrl: URL,
): "prefetch" | "fill" | undefined {
  if (rawUrl.searchParams.has(FILL_PARAM)) return "fill";
  return requestHeaders(request).has(PREFETCH_HEADER) ? "prefetch" : undefined;
}

/** Static, per matched chain. */
interface DeferralScope {
  /**
   * Loader registrations a prefetch can defer, each with what makes it so:
   * `true` for its own flag, else the segment ids of the flagged entries whose
   * fallback covers it. A covered loader is deferred only while one of those
   * segments is new to the client.
   */
  readonly loaders: ReadonlyMap<LoaderEntry, true | readonly string[]>;
  /** `$$id`s of `loaders`: the loaders that cannot call ctx.rendered(). */
  readonly loaderIds: ReadonlySet<string>;
  /**
   * Entries whose handler a prefetch can skip (a flagged loading() with a
   * fallback to show). `index` is the chain index that owns the entry: its
   * own for a chain entry, its parent's for a parallel entry. `ids` are its
   * segment ids: the entry's for a chain entry, one per slot for a parallel
   * entry.
   */
  readonly units: ReadonlyMap<EntryData, DeferralUnit>;
}

interface DeferralUnit {
  readonly index: number;
  readonly ids: readonly string[];
}

/** Per match: InternalHandlerContext._prefetchDeferral. */
export interface PrefetchDeferral {
  readonly scope: DeferralScope;
  /**
   * "prefetch": deferral replaces execution. "fill": the request that follows
   * an adopted prefetch; a held segment is skipped outright. Unset on every
   * other request, where the plan only feeds the ctx.rendered() guards.
   */
  readonly mode?: "prefetch" | "fill";
  /**
   * First chain index whose handler output is stored or about to be (a
   * cache() boundary, a ppr or Prerender route): no unit at or below it.
   */
  readonly storedFrom: number;
  /** The segment ids the request listed as held (`_rsc_segments`). */
  readonly held: ReadonlySet<string>;
  /**
   * Segment ids of the handler units this prefetch skips: every unit that is
   * not stored and not held. Empty outside a prefetch.
   */
  readonly skipped: ReadonlySet<string>;
  /** How this request may use the route's cache() record (recordUse). */
  readonly record: RecordUse;
  /** Segment id of the handler unit this prefetch skipped. */
  deferredUnit?: string;
  /**
   * The walk is below a chain unit it skipped (resolution is in chain order,
   * a route's orphan layouts and slots after its handler): every handler it
   * reaches from here on is skipped too, and sends a placeholder with what
   * the entry declares. The browser builds the page's tree once, from those
   * (browser/partial-update.ts armHoles), so they have to list every segment
   * a navigation to the page lists.
   */
  below?: true;
  /**
   * The loaders this prefetch deferred, by `$$id` (registerDeferredLoader).
   * A deferred loader runs only if something reads it: a handler's or another
   * loader's ctx.use() starts it through its registration
   * (startDeferredLoader), and revalidation.ts deliverStartedLoaders delivers
   * what was started by the end of resolution.
   */
  deferredLoaders?: Map<string, DeferredLoader>;
}

/**
 * How a request may use the route's cache() record, decided once per match
 * (planPrefetchDeferral) for the cache middleware.
 */
export interface RecordUse {
  /**
   * withCacheLookup reads it. False when this prefetch skips a chain unit
   * (PrefetchDeferral.skipped): the unit takes everything below it, so the
   * read would replay the record's handle pushes for segments the response
   * does not carry. Decided from what the client holds, never per tree: a
   * prefetch that holds the flagged layout reads and writes the record like
   * any other request.
   */
  readonly read: boolean;
  /** withCacheStore writes it. False where `read` is: the record would be incomplete. */
  readonly write: boolean;
  /**
   * A background re-render of the whole route may write it: the stale-hit
   * refresh (withBackgroundRevalidation) and the proactive write a partial
   * response needs (withCacheStore). False for a fill: the re-render runs
   * the handlers of segments the client holds, which a fill does not run.
   */
  readonly refresh: boolean;
}

/** A loader this prefetch deferred: PrefetchDeferral.deferredLoaders. */
export interface DeferredLoader {
  /**
   * The segment that registers it. Its run files its handle pushes there,
   * where a navigation's run of it files them, not under the reader
   * (loaderOwner).
   */
  readonly owner: string;
  /**
   * Starts it as resolution would have: resolveLoaderData with its cache()
   * binding, so the reader and the delivered segment share one value.
   */
  readonly start: () => Promise<unknown>;
  /** A reader started it. */
  started?: true;
}

const EMPTY_SCOPE: DeferralScope = {
  loaders: new Map(),
  loaderIds: new Set(),
  units: new Map(),
};

const scopes = new WeakMap<EntryData, DeferralScope>();
const warnedBakeLoaders = new Set<string>();

/**
 * The deferral scope of a matched chain, memoized on its leaf entry (entries
 * are per-isSSR manifest objects, replaced on HMR). EMPTY_SCOPE when nothing
 * in the tree declares `prefetch: false`.
 */
export function resolveDeferralScope(
  entries: readonly EntryData[],
): DeferralScope {
  const leaf = entries[entries.length - 1];
  if (!leaf) return EMPTY_SCOPE;
  const cached = scopes.get(leaf);
  if (cached) return cached;

  const loaders = new Map<LoaderEntry, true | readonly string[]>();
  const loaderIds = new Set<string>();
  const units = new Map<EntryData, DeferralUnit>();
  const chain = new Set(entries);
  // ssr: false on a ppr route is the bake lane (loader-cache.ts
  // resolveLoaderData): shell material, served from the record.
  const pprRoute = isPprEntry(leaf);
  // A clientUrls() group route renders loading() itself and its handler is
  // ClientUrlsRoot (segment-system.tsx keys it by group): a unit would hand
  // React a promise in place of the optimistic destination on screen. So
  // in its chain only a loader's own flag counts, the group's and a server
  // layout's above it; a flagged loading() defers nothing.
  const clientGroupChain = leaf.clientGroup !== undefined;
  const flagsLoading = (entry: EntryData): boolean =>
    !clientGroupChain && entry.loadingPrefetch === false;

  // `behind`: the segment ids of the flagged entries whose fallback covers
  // `entry`'s loaders.
  const collect = (
    entry: EntryData,
    behind: readonly string[],
    index: number,
  ): void => {
    for (const loaderEntry of entry.loader ?? []) {
      const own = loaderEntry.prefetch === false;
      if (!own && behind.length === 0) continue;
      if (pprRoute && loaderEntry.bake) {
        if (
          process.env.NODE_ENV !== "production" &&
          loaderEntry.prefetch === false &&
          !warnedBakeLoaders.has(loaderEntry.loader.$$id)
        ) {
          warnedBakeLoaders.add(loaderEntry.loader.$$id);
          console.warn(
            `[rango] loader "${loaderEntry.loader.$$id}" is registered with ssr: false and prefetch: false on a ppr route ("${leaf.id}"). ` +
              `Under ppr an ssr: false loader is baked into the shell and served from it, so prefetch: false is ignored there. Drop one of the two options.`,
          );
        }
        continue;
      }
      loaders.set(loaderEntry, own ? true : behind);
      loaderIds.add(loaderEntry.loader.$$id);
    }
    for (const parallelEntry of getParallelEntries(entry.parallel)) {
      // A slot's segment id, as resolveParallelSegmentsWithRevalidation
      // (revalidation.ts) forms it.
      const slotIds = flagsLoading(parallelEntry)
        ? getParallelSlotEntries(entry.parallel)
            .filter((slot) => slot.entry === parallelEntry)
            .map((slot) => `${entry.shortCode}.${slot.slot}`)
        : [];
      if (slotIds.length > 0) units.set(parallelEntry, { index, ids: slotIds });
      collect(parallelEntry, [...behind, ...slotIds], index);
    }
    for (const orphan of entry.layout) {
      if (chain.has(orphan)) continue;
      // An orphan layout's handler is awaited after its owner's ran
      // (revalidation.ts resolveOrphanLayoutWithRevalidation): never a unit,
      // its loaders are still behind its fallback.
      collect(
        orphan,
        flagsLoading(orphan) ? [...behind, orphan.shortCode] : behind,
        index,
      );
    }
  };

  let behind: readonly string[] = [];
  entries.forEach((entry, index) => {
    const flagged = flagsLoading(entry);
    if (flagged) units.set(entry, { index, ids: [entry.shortCode] });
    const own = flagged ? [...behind, entry.shortCode] : behind;
    collect(entry, own, index);
    // A layout's fallback covers its outlet: every deeper chain entry.
    if (flagged && entry.type !== "route") behind = own;
  });

  const scope: DeferralScope =
    loaders.size === 0 && units.size === 0
      ? EMPTY_SCOPE
      : { loaders, loaderIds, units };
  scopes.set(leaf, scope);
  return scope;
}

/**
 * Which half of the feature a partial request is, if either (`fill` and
 * `prefetch` are requestKind's answer). Both halves are GETs: a request of
 * another method that carries either marker is a normal request. A prefetch
 * defers only on a plain GET navigation: an action re-renders what it
 * changed, an intercept resolves its loaders outside the shared funnel, and a
 * shell capture is never a prefetch whatever the request that scheduled it
 * sent. The four conditions overlap today (an action is a POST, a capture
 * runs the full match): each one states its own reason.
 */
export function partialDeferralMode(request: {
  fill: boolean;
  prefetch: boolean;
  method: string;
  isAction: boolean;
  isIntercept: boolean;
  isShellCapture: boolean;
}): PrefetchDeferral["mode"] {
  if (request.method !== "GET") return undefined;
  if (request.fill) return "fill";
  return request.prefetch &&
    !request.isAction &&
    !request.isIntercept &&
    !request.isShellCapture
    ? "prefetch"
    : undefined;
}

const NOTHING_HELD: ReadonlySet<string> = new Set();

/**
 * The plan for one match, or undefined when the tree declares no flag and the
 * request is not a fill (the common case: nothing to carry). `held` is the
 * client's segment ids as the request listed them.
 */
export function planPrefetchDeferral(
  entries: readonly EntryData[],
  mode: PrefetchDeferral["mode"],
  matched: { pr?: boolean; od?: boolean },
  cacheScope: CacheScope | null | undefined,
  held: ReadonlySet<string> = NOTHING_HELD,
): PrefetchDeferral | undefined {
  const scope = resolveDeferralScope(entries);
  if (scope === EMPTY_SCOPE && mode !== "fill") return undefined;

  const leaf = entries[entries.length - 1];
  let storedFrom = Infinity;
  if (
    matched.pr ||
    matched.od ||
    (leaf &&
      (isPprEntry(leaf) ||
        // A Prerender route is stored whether or not this request found the
        // artifact (dev renders it live): the rule is the declaration's.
        (leaf.type === "route" && leaf.isPrerender)))
  ) {
    storedFrom = 0;
  } else if (cacheScope?.enabled) {
    // The same index withCacheLookup resolves its live entries above.
    storedFrom =
      cacheScope.boundary === undefined
        ? 0
        : Math.max(
            0,
            entries.findIndex((e) => e.shortCode === cacheScope.boundary),
          );
  }

  const skipped = new Set<string>();
  let skipsChain = false;
  if (mode === "prefetch") {
    for (const [entry, unit] of scope.units) {
      if (!unitEligible(storedFrom, entry, unit)) continue;
      for (const id of unit.ids) {
        if (held.has(id)) continue;
        skipped.add(id);
        if (entry.type !== "parallel") skipsChain = true;
      }
    }
  }
  const record: RecordUse = {
    read: !skipsChain,
    write: !skipsChain,
    refresh: mode !== "fill",
  };
  return { scope, mode, storedFrom, held, skipped, record };
}

export function getPrefetchDeferral(
  ctx: HandlerContext<any, any> | undefined,
): PrefetchDeferral | undefined {
  return (ctx as InternalHandlerContext<any, any> | undefined)
    ?._prefetchDeferral;
}

/** The request is a fill: a held segment is skipped without consulting anything. */
export function isFillRequest(ctx: HandlerContext<any, any>): boolean {
  return getPrefetchDeferral(ctx)?.mode === "fill";
}

/**
 * A fill's whole revalidation rule (R5): send a segment the client does not
 * hold, keep one it holds, and consult nothing else (no revalidate()
 * predicate, no params or search comparison, no trace entry). Undefined on
 * any other request, where revalidation decides. `held` is the set the
 * deciding site resolves with.
 */
export function fillSends(
  ctx: HandlerContext<any, any>,
  segmentId: string,
  held: ReadonlySet<string>,
): boolean | undefined {
  return isFillRequest(ctx) ? !held.has(segmentId) : undefined;
}

const RECORD_OPEN: RecordUse = { read: true, write: true, refresh: true };

/** PrefetchDeferral.record, or all of it open when the match has no plan. */
export function recordUse(
  ctx: HandlerContext<any, any> | undefined,
): RecordUse {
  return getPrefetchDeferral(ctx)?.record ?? RECORD_OPEN;
}

/**
 * Register a loader this prefetch deferred, with the segment that registers
 * it and how to start it there (PrefetchDeferral.deferredLoaders). The first
 * registration wins, as the loader's one run per request does.
 */
export function registerDeferredLoader(
  ctx: HandlerContext<any, any>,
  loaderId: string,
  owner: string,
  start: () => Promise<unknown>,
): void {
  const plan = getPrefetchDeferral(ctx);
  if (plan && !plan.deferredLoaders?.has(loaderId)) {
    (plan.deferredLoaders ??= new Map()).set(loaderId, { owner, start });
  }
}

/**
 * A reader asks for a loader this prefetch deferred and nothing has started:
 * start it through its registration and return the run, or undefined when
 * the read takes the ordinary path. Without this the reader ran the loader
 * bare, without its cache() binding, and the segment delivered afterwards
 * read the binding: two values on one page and an extra run on a HIT.
 *
 * A started cache() binding of the loader (`_loaderCacheOverrides`) is never
 * redirected here: the read is that binding's own MISS execution, and
 * starting the registration would hand the binding its own pending value.
 */
export function startDeferredLoader(
  ctx: HandlerContext<any, any>,
  loaderId: string,
): Promise<unknown> | undefined {
  const internal = ctx as InternalHandlerContext<any, any>;
  const deferred = internal._prefetchDeferral?.deferredLoaders?.get(loaderId);
  if (
    !deferred ||
    deferred.started ||
    internal._loaderCacheOverrides?.has(loaderId)
  ) {
    return undefined;
  }
  deferred.started = true;
  return deferred.start();
}

/**
 * The segment a run of `loaderId` files its handle pushes under: the one
 * that registers it when this prefetch deferred it, else the segment being
 * resolved.
 */
export function loaderOwner(
  ctx: HandlerContext<any, any>,
  loaderId: string,
): string | undefined {
  const internal = ctx as InternalHandlerContext<any, any>;
  return (
    internal._prefetchDeferral?.deferredLoaders?.get(loaderId)?.owner ??
    internal._currentSegmentId
  );
}

/**
 * This prefetch defers `loaderEntry`, whose segment is `segmentId`: the client
 * does not hold that segment, and the loader is flagged itself or sits behind
 * the fallback of a flagged entry the client does not hold either. Under a
 * flagged layout the client holds, a new route's loaders run.
 */
export function defersLoader(
  ctx: HandlerContext<any, any>,
  loaderEntry: LoaderEntry,
  segmentId: string,
): boolean {
  const plan = getPrefetchDeferral(ctx);
  if (plan?.mode !== "prefetch" || plan.held.has(segmentId)) return false;
  const by = plan.scope.loaders.get(loaderEntry);
  return (
    by === true || (by !== undefined && by.some((id) => !plan.held.has(id)))
  );
}

/** A unit whose handler output is not stored: a prefetch can skip it. */
function unitEligible(
  storedFrom: number,
  entry: EntryData,
  unit: DeferralUnit,
): boolean {
  return (
    unit.index < storedFrom &&
    !("isStaticPrerender" in entry && entry.isStaticPrerender)
  );
}

/**
 * This prefetch skips the handler of the entry whose segment is `segmentId`:
 * a unit the client does not hold, or anything the client does not hold
 * below one (belowDeferredUnit). A held segment that re-renders is rendered
 * by the prefetch, as by a navigation.
 */
export function defersUnit(
  ctx: HandlerContext<any, any>,
  segmentId: string,
): boolean {
  return (
    getPrefetchDeferral(ctx)?.skipped.has(segmentId) === true ||
    belowDeferredUnit(ctx, segmentId)
  );
}

/**
 * `segmentId` is new to the client and the walk is below a chain unit this
 * prefetch skipped (PrefetchDeferral.below). Nothing of such a segment runs
 * in the prefetch, a slot's revalidate() predicates included: on a new
 * segment they cannot change the outcome, and what they would read from
 * context was set by handlers that did not run.
 */
export function belowDeferredUnit(
  ctx: HandlerContext<any, any>,
  segmentId: string,
): boolean {
  const plan = getPrefetchDeferral(ctx);
  return plan?.below === true && !plan.held.has(segmentId);
}

/**
 * A unit candidate that is not stored: a prefetch of this tree can skip a
 * handler. Returns its entry (the first in chain order), for the
 * ctx.rendered() guards (loader-resolution.ts).
 */
export function firstUnitCandidate(
  plan: PrefetchDeferral,
): EntryData | undefined {
  for (const [entry, unit] of plan.scope.units) {
    if (unitEligible(plan.storedFrom, entry, unit)) return entry;
  }
  return undefined;
}

/**
 * Record the handler unit this prefetch skipped. A `chain` entry takes what
 * the walk reaches after it (PrefetchDeferral.below); a slot is skipped
 * alone.
 */
export function markUnitDeferred(
  ctx: HandlerContext<any, any>,
  segmentId: string,
  chain?: boolean,
): void {
  const plan = getPrefetchDeferral(ctx);
  if (!plan) return;
  plan.deferredUnit ??= segmentId;
  if (chain) plan.below = true;
}

/** What the segment of a unit a prefetch skipped carries. */
const DEFERRED = { deferred: true } as const;

/**
 * Whether this prefetch skips the handler of the unit whose segment is
 * `segmentId`, recorded: the flag the segment carries
 * (ResolvedSegment.deferred), or undefined when the handler runs.
 * - `chain`: a chain entry, its own unit or below one (defersUnit). The walk
 *   takes what it reaches after it (markUnitDeferred).
 * - `slot`: a slot that is its own unit, skipped alone.
 * - `below`: what the walk reaches below a chain unit it skipped
 *   (belowDeferredUnit): a slot, before its predicates run, and an orphan
 *   layout, which is never a unit of its own (resolveDeferralScope). The unit
 *   above is recorded already.
 */
export function deferUnit(
  ctx: HandlerContext<any, any>,
  segmentId: string,
  kind: "chain" | "slot" | "below",
): { readonly deferred: true } | undefined {
  if (kind === "below") {
    return belowDeferredUnit(ctx, segmentId) ? DEFERRED : undefined;
  }
  if (
    kind === "chain"
      ? !defersUnit(ctx, segmentId)
      : getPrefetchDeferral(ctx)?.skipped.has(segmentId) !== true
  ) {
    return undefined;
  }
  markUnitDeferred(ctx, segmentId, kind === "chain");
  return DEFERRED;
}
