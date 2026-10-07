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
 */

import {
  getParallelEntries,
  isPprEntry,
  type EntryData,
  type LoaderEntry,
} from "../../server/context.js";
import type { HandlerContext, InternalHandlerContext } from "../../types";
import type { CacheScope } from "../../cache/cache-scope.js";

/** Static, per matched chain. */
export interface DeferralScope {
  /** Loader registrations a prefetch defers when they would run. */
  readonly loaders: ReadonlySet<LoaderEntry>;
  /** `$$id`s of `loaders`: the loaders that cannot call ctx.rendered(). */
  readonly loaderIds: ReadonlySet<string>;
  /**
   * Entries whose handler a prefetch can skip (a flagged loading() with a
   * fallback to show), mapped to the chain index that owns them: a chain
   * entry maps to its own index, a parallel entry to its parent's.
   */
  readonly units: ReadonlyMap<EntryData, number>;
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
  /** Segment id of the handler unit this prefetch skipped. */
  deferredUnit?: string;
}

const EMPTY_SCOPE: DeferralScope = {
  loaders: new Set(),
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

  const loaders = new Set<LoaderEntry>();
  const loaderIds = new Set<string>();
  const units = new Map<EntryData, number>();
  const chain = new Set(entries);
  // ssr: false on a ppr route is the bake lane (loader-cache.ts
  // resolveLoaderData): shell material, served from the record.
  const pprRoute = isPprEntry(leaf);
  // clientUrls() group routes present their destination in the browser and
  // render loading() themselves (segment-system.tsx): the flag is inert.
  const inert = leaf.clientGroup !== undefined;

  const collect = (entry: EntryData, behind: boolean, index: number): void => {
    for (const loaderEntry of entry.loader ?? []) {
      if (!behind && loaderEntry.prefetch !== false) continue;
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
      loaders.add(loaderEntry);
      loaderIds.add(loaderEntry.loader.$$id);
    }
    for (const parallelEntry of getParallelEntries(entry.parallel)) {
      const flagged = flagsLoading(parallelEntry);
      if (flagged) units.set(parallelEntry, index);
      collect(parallelEntry, behind || flagged, index);
    }
    for (const orphan of entry.layout) {
      if (chain.has(orphan)) continue;
      // An orphan layout's handler is awaited after its owner's ran
      // (revalidation.ts resolveOrphanLayoutWithRevalidation): never a unit,
      // its loaders are still behind its fallback.
      collect(orphan, behind || flagsLoading(orphan), index);
    }
  };

  if (!inert) {
    let behind = false;
    entries.forEach((entry, index) => {
      const flagged = flagsLoading(entry);
      if (flagged) units.set(entry, index);
      collect(entry, behind || flagged, index);
      // A layout's fallback covers its outlet: every deeper chain entry.
      if (flagged && entry.type !== "route") behind = true;
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
 * Which half of the feature a partial request is, if either. A fill is marked
 * on the raw URL (browser/navigation-client.ts) and wins over the prefetch
 * header. A prefetch defers only on a plain GET navigation: an action
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

/**
 * The plan for one match, or undefined when the tree declares no flag and the
 * request is not a fill (the common case: nothing to carry).
 */
export function planPrefetchDeferral(
  entries: readonly EntryData[],
  mode: PrefetchDeferral["mode"],
  matched: { pr?: boolean; od?: boolean },
  cacheScope: CacheScope | null | undefined,
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
  return { scope, mode, storedFrom };
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

/** This prefetch defers `loaderEntry` when it would run. */
export function defersLoader(
  ctx: HandlerContext<any, any>,
  loaderEntry: LoaderEntry,
): boolean {
  const plan = getPrefetchDeferral(ctx);
  return plan?.mode === "prefetch" && plan.scope.loaders.has(loaderEntry);
}

function unitEligible(plan: PrefetchDeferral, entry: EntryData): boolean {
  const index = plan.scope.units.get(entry);
  return (
    index !== undefined &&
    index < plan.storedFrom &&
    !("isStaticPrerender" in entry && entry.isStaticPrerender)
  );
}

/** This prefetch skips `entry`'s handler when it would run. */
export function defersUnit(
  ctx: HandlerContext<any, any>,
  entry: EntryData,
): boolean {
  const plan = getPrefetchDeferral(ctx);
  return plan?.mode === "prefetch" && unitEligible(plan, entry);
}

/**
 * A unit candidate that is not stored: a prefetch of this tree can skip a
 * handler. Returns its entry (the first in chain order), for the
 * ctx.rendered() guards (loader-resolution.ts).
 */
export function firstUnitCandidate(
  plan: PrefetchDeferral,
): EntryData | undefined {
  for (const entry of plan.scope.units.keys()) {
    if (unitEligible(plan, entry)) return entry;
  }
  return undefined;
}

/**
 * This prefetch can skip a layout or route above the route cache's boundary,
 * and with it everything the record below holds: withCacheLookup and
 * withCacheStore leave the record alone for it.
 */
export function chainUnitPossible(ctx: HandlerContext<any, any>): boolean {
  const plan = getPrefetchDeferral(ctx);
  if (plan?.mode !== "prefetch") return false;
  for (const entry of plan.scope.units.keys()) {
    if (entry.type !== "parallel" && unitEligible(plan, entry)) return true;
  }
  return false;
}

/** Record the handler unit this prefetch skipped. */
export function markUnitDeferred(
  ctx: HandlerContext<any, any>,
  segmentId: string,
): void {
  const plan = getPrefetchDeferral(ctx);
  if (plan) plan.deferredUnit ??= segmentId;
}
