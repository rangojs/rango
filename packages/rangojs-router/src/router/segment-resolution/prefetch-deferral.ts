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

/** Request header of a `<Link>` prefetch (browser/prefetch/fetch.ts). */
export const PREFETCH_HEADER = "X-Rango-Prefetch";
/** Query param of a fill request (browser/navigation-client.ts). */
export const FILL_PARAM = "_rsc_fill";

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
export interface DeferralScope {
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
  /**
   * One of `skipped` is a chain entry: the walk stops there, so the response
   * lacks everything below it, a route cache() record included.
   */
  readonly skipsChain: boolean;
  /** Segment id of the handler unit this prefetch skipped. */
  deferredUnit?: string;
}

const EMPTY_SCOPE: DeferralScope = {
  loaders: new Map(),
  loaderIds: new Set(),
  units: new Map(),
};

const scopes = new WeakMap<EntryData, DeferralScope>();
const warnedBakeLoaders = new Set<string>();

function flagsLoading(entry: EntryData): boolean {
  return entry.loadingPrefetch === false;
}

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
  // clientUrls() group routes present their destination in the browser and
  // render loading() themselves (segment-system.tsx): the flag is inert.
  const inert = leaf.clientGroup !== undefined;

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

  if (!inert) {
    let behind: readonly string[] = [];
    entries.forEach((entry, index) => {
      const flagged = flagsLoading(entry);
      if (flagged) units.set(entry, { index, ids: [entry.shortCode] });
      const own = flagged ? [...behind, entry.shortCode] : behind;
      collect(entry, own, index);
      // A layout's fallback covers its outlet: every deeper chain entry.
      if (flagged && entry.type !== "route") behind = own;
    });
  }

  const scope: DeferralScope =
    loaders.size === 0 && units.size === 0
      ? EMPTY_SCOPE
      : { loaders, loaderIds, units };
  scopes.set(leaf, scope);
  return scope;
}

/**
 * Which half of the feature a partial request is, if either (`fill` and
 * `prefetch` are requestKind's answer). A prefetch defers only on a plain GET
 * navigation: an action
 * re-renders what it changed, an intercept resolves its loaders outside the
 * shared funnel, and a shell capture is never a prefetch whatever the request
 * that scheduled it sent. The four conditions overlap today (an action is a
 * POST, a capture runs the full match): each one states its own reason.
 */
export function partialDeferralMode(request: {
  fill: boolean;
  prefetch: boolean;
  method: string;
  isAction: boolean;
  isIntercept: boolean;
  isShellCapture: boolean;
}): PrefetchDeferral["mode"] {
  if (request.fill) return "fill";
  return request.prefetch &&
    request.method === "GET" &&
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
  return { scope, mode, storedFrom, held, skipped, skipsChain };
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
 * a unit the client does not hold. A held segment that re-renders is rendered
 * by the prefetch, as by a navigation.
 */
export function defersUnit(
  ctx: HandlerContext<any, any>,
  segmentId: string,
): boolean {
  return getPrefetchDeferral(ctx)?.skipped.has(segmentId) === true;
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
 * This prefetch skips a layout above the route cache's boundary, and with it
 * everything the record below holds: withCacheLookup and withCacheStore leave
 * the record alone for it. Decided per request, from what the client holds:
 * a prefetch of the same tree that holds the layout reads and writes the
 * record like any other request.
 */
export function defersAboveRecord(ctx: HandlerContext<any, any>): boolean {
  return getPrefetchDeferral(ctx)?.skipsChain === true;
}

/** Record the handler unit this prefetch skipped. */
export function markUnitDeferred(
  ctx: HandlerContext<any, any>,
  segmentId: string,
): void {
  const plan = getPrefetchDeferral(ctx);
  if (plan) plan.deferredUnit ??= segmentId;
}
