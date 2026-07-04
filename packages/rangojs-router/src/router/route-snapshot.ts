/**
 * Route Snapshot
 *
 * Pure data type representing the fully-resolved state of a single route match.
 * Consolidates the duplicated findMatch + loadManifest + collectRouteMiddleware +
 * cacheScope derivation that previously lived separately in preview-match.ts
 * and match-api.ts.
 *
 * resolveRoute() is the factory: given a pathname and dependencies, it returns
 * a RouteSnapshot (or redirect/null). Consumers (createMatchContextForFull,
 * createMatchContextForPartial, previewMatch) read snapshot fields instead of
 * re-deriving them.
 */

import type { CacheScope } from "../cache/cache-scope.js";
import { createCacheScope } from "../cache/cache-scope.js";
import type { EntryData, MetricsStore } from "../server/context.js";
import { loadManifest } from "./manifest.js";
import { collectRouteMiddleware } from "./middleware.js";
import type { CollectedMiddleware } from "./middleware-types.js";
import { traverseBack } from "./pattern-matching.js";
import type { RouteMatchResult } from "./pattern-matching.js";

/**
 * Immutable snapshot of a resolved route match.
 *
 * Contains everything derivable from (pathname, findMatch, loadManifest)
 * without request context, navigation state, or intercept logic.
 */
export interface RouteSnapshot<TEnv = any> {
  /** Raw match result from the trie/pattern matcher */
  matched: RouteMatchResult<TEnv>;
  /** Resolved manifest entry (with loaded handler, loader, etc.) */
  manifestEntry: EntryData;
  /** All entries in the route chain (from traverseBack) */
  entries: EntryData[];
  /** Canonical route key (e.g. "blog.detail") */
  routeKey: string;
  /** Last segment of a dotted route key (e.g. "detail" from "blog.detail") */
  localRouteName: string;
  /** Extracted route params */
  params: Record<string, string>;
  /** Collected route-level middleware from the entry tree */
  routeMiddleware: CollectedMiddleware[];
  /** Merged cache scope from the entry chain */
  cacheScope: CacheScope | null;
  /** Whether the matched route is a passthrough route */
  isPassthrough: boolean;
  /** Response type for non-RSC routes (e.g. "application/json") */
  responseType?: string;
  /**
   * The isSSR flag the manifest was resolved with. Recorded so consumers can
   * decide whether the snapshot is reusable: a snapshot resolved with isSSR
   * differs (loading({ ssr: false }) entries) and is cached under a different
   * manifest partition, so the full (document) path only reuses an isSSR:true
   * snapshot and the partial path only reuses a non-isSSR one. Undefined on
   * inline snapshots (redirect / not-found) that are never reused.
   */
  isSSR?: boolean;
}

export type ResolveRouteResult<TEnv = any> =
  | { type: "match"; snapshot: RouteSnapshot<TEnv> }
  | { type: "redirect"; redirectTo: string }
  | null;

export interface ResolveRouteDeps<TEnv = any> {
  findMatch: (
    pathname: string,
  ) => RouteMatchResult<TEnv> | null | Promise<RouteMatchResult<TEnv> | null>;
  metricsStore?: MetricsStore;
  isSSR?: boolean;
  /**
   * When true, skip entries array and cacheScope chain construction.
   * Used by previewMatch which only needs matched, manifestEntry,
   * routeMiddleware, and responseType — avoids an extra traverseBack
   * allocation and cacheScope composition on the hot classification path.
   */
  lite?: boolean;
  /**
   * When true, skip pushing the "route-matching" metric internally.
   * Used by createMatchContextForPartial on the fresh path (no snapshot
   * reuse) so it can measure current + prev + intercept-source findMatch
   * calls under one combined "route-matching" metric. On the reuse path,
   * the partial path emits "route-matching:nav" for the prev +
   * intercept-source lookups only (current-route resolution was done
   * during classification without metrics).
   */
  skipRouteMatchMetric?: boolean;
}

/**
 * Resolve a pathname into a RouteSnapshot.
 *
 * This is the single source of truth for route derivation. It performs:
 * 1. findMatch(pathname)
 * 2. Redirect check
 * 3. loadManifest
 * 4. Passthrough detection
 * 5. collectRouteMiddleware
 * 6. Cache scope chain
 * 7. responseType + localRouteName extraction
 *
 * Metrics timing is preserved identically to the previous inline code.
 */
export async function resolveRoute<TEnv = any>(
  pathname: string,
  deps: ResolveRouteDeps<TEnv>,
): Promise<ResolveRouteResult<TEnv>> {
  const {
    metricsStore,
    isSSR = false,
    lite = false,
    skipRouteMatchMetric = false,
  } = deps;

  const routeMatchStart =
    metricsStore && !skipRouteMatchMetric ? performance.now() : 0;
  const matched = await deps.findMatch(pathname);
  if (metricsStore && !skipRouteMatchMetric) {
    metricsStore.metrics.push({
      label: "route-matching",
      duration: performance.now() - routeMatchStart,
      startTime: routeMatchStart - metricsStore.requestStart,
    });
  }

  if (!matched) {
    return null;
  }

  if (matched.redirectTo) {
    return { type: "redirect", redirectTo: matched.redirectTo };
  }

  const manifestStart = metricsStore ? performance.now() : 0;
  const manifestEntry = await loadManifest(
    matched.entry,
    matched.routeKey,
    pathname,
    metricsStore,
    isSSR,
  );
  if (metricsStore) {
    metricsStore.metrics.push({
      label: "manifest-loading",
      duration: performance.now() - manifestStart,
      startTime: manifestStart - metricsStore.requestStart,
    });
  }

  const isPassthrough =
    manifestEntry.type === "route" && manifestEntry.isPassthrough === true;

  let entries: EntryData[];
  let cacheScope: CacheScope | null = null;
  if (lite) {
    entries = [];
  } else {
    ({ entries, cacheScope } = buildEntriesAndCacheScope(manifestEntry));
  }

  const routeMiddleware = collectRouteMiddleware(
    lite ? traverseBack(manifestEntry) : entries,
    matched.params,
  );

  const responseType =
    matched.responseType ||
    (manifestEntry.type === "route" ? manifestEntry.responseType : undefined);

  const localRouteName = matched.routeKey.includes(".")
    ? matched.routeKey.split(".").pop()!
    : matched.routeKey;

  return {
    type: "match",
    snapshot: {
      matched,
      manifestEntry,
      entries,
      routeKey: matched.routeKey,
      localRouteName,
      params: matched.params,
      routeMiddleware,
      cacheScope,
      isPassthrough,
      responseType,
      isSSR,
    },
  };
}

/**
 * Fill in the entries and cacheScope fields on a lite snapshot.
 *
 * When classifyRequest produces a lite snapshot (entries=[], cacheScope=null),
 * this function computes the missing fields from manifestEntry without
 * re-running findMatch, loadManifest, or collectRouteMiddleware.
 *
 * If the snapshot already has entries, returns it as-is.
 */
export function ensureFullRouteSnapshot<TEnv = any>(
  snapshot: RouteSnapshot<TEnv>,
): RouteSnapshot<TEnv> {
  if (snapshot.entries.length > 0) {
    return snapshot;
  }

  const { entries, cacheScope } = buildEntriesAndCacheScope(
    snapshot.manifestEntry,
  );
  return { ...snapshot, entries, cacheScope };
}

/**
 * Materialize the entry chain and derive the merged cache scope.
 * Shared by resolveRoute (non-lite) and ensureFullRouteSnapshot.
 */
function buildEntriesAndCacheScope(manifestEntry: EntryData): {
  entries: EntryData[];
  cacheScope: CacheScope | null;
} {
  const entries = [...traverseBack(manifestEntry)];
  let cacheScope: CacheScope | null = null;
  for (const entry of entries) {
    if (entry.cache) {
      cacheScope = createCacheScope(entry.cache, cacheScope);
    }
  }
  return { entries, cacheScope };
}

/**
 * Test helper: create a RouteSnapshot with sensible defaults and overrides.
 */
export function createRouteSnapshot<TEnv = any>(
  overrides?: Partial<RouteSnapshot<TEnv>>,
): RouteSnapshot<TEnv> {
  return {
    matched: {
      entry: {} as any,
      routeKey: "test",
      params: {},
    } as RouteMatchResult<TEnv>,
    manifestEntry: { type: "route", shortCode: "R0", parent: null } as any,
    entries: [],
    routeKey: "test",
    localRouteName: "test",
    params: {},
    routeMiddleware: [],
    cacheScope: null,
    isPassthrough: false,
    ...overrides,
  };
}
