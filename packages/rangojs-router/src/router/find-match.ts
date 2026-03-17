import { tryTrieMatch } from "./trie-matching.js";
import { getRouteTrie, getRouterTrie } from "../route-map-builder.js";
import {
  findMatch as findRouteMatch,
  isLazyEvaluationNeeded,
  type RouteMatchResult,
} from "./pattern-matching.js";
import type { MetricsStore } from "../server/context";
import type { RouteEntry } from "../types";

export interface FindMatchDeps<TEnv = any> {
  routesEntries: RouteEntry<TEnv>[];
  evaluateLazyEntry: (entry: RouteEntry<TEnv>) => void;
  routerId: string;
}

/**
 * Create a findMatch function bound to router state.
 * Includes single-entry cache to avoid redundant matching within the same request.
 */
export function createFindMatch<TEnv = any>(
  deps: FindMatchDeps<TEnv>,
): (pathname: string, ms?: MetricsStore) => RouteMatchResult<TEnv> | null {
  // Single-entry cache for findMatch to avoid redundant matching within the same request.
  // previewMatch and match both call findMatch with the same pathname — this ensures
  // the route matching work (which may check thousands of routes) only happens once.
  let lastFindMatchPathname: string | null = null;
  let lastFindMatchResult: RouteMatchResult<TEnv> | null = null;

  // Wrapper for findMatch that uses routesEntries
  // Handles lazy evaluation by evaluating lazy entries on first match.
  // Phase 1: try O(path_length) trie match.
  // Phase 2: fall back to regex iteration.
  return function findMatch(
    pathname: string,
    ms?: MetricsStore,
  ): RouteMatchResult<TEnv> | null {
    // Return cached result if same pathname (avoids double-match per request)
    if (lastFindMatchPathname === pathname) {
      return lastFindMatchResult;
    }

    // Helper to push sub-metrics
    const pushMetric = ms
      ? (label: string, start: number) => {
          ms.metrics.push({
            label,
            duration: performance.now() - start,
            startTime: start - ms.requestStart,
          });
        }
      : undefined;

    // Phase 1: Try trie match (O(path_length))
    // Only use the per-router trie. The global trie merges routes from ALL
    // routers and must not be used — in multi-router setups (host routing)
    // overlapping paths like "/" would match the wrong app's route.
    const routeTrie = getRouterTrie(deps.routerId);
    if (routeTrie) {
      const trieStart = performance.now();
      const trieResult = tryTrieMatch(routeTrie, pathname);
      pushMetric?.("match:trie", trieStart);

      if (trieResult) {
        // Find the RouteEntry that contains this route.
        // Multiple entries can share the same staticPrefix (e.g., several
        // include("/", patterns) calls all produce staticPrefix=""). Evaluate
        // each candidate and pick the one whose routes include the matched key.
        const entryStart = performance.now();
        let entry: RouteEntry<TEnv> | undefined;
        let fallbackEntry: RouteEntry<TEnv> | undefined;

        for (const e of deps.routesEntries) {
          if (e.staticPrefix !== trieResult.sp) continue;
          if (!fallbackEntry) fallbackEntry = e;
          deps.evaluateLazyEntry(e);
          if (
            e.routes &&
            trieResult.routeKey in (e.routes as Record<string, unknown>)
          ) {
            entry = e;
            break;
          }
        }

        // If no entry had the route in its routes map, use the first matching
        // entry as fallback (handles main entry with inline routes not yet
        // reflected in its routes object).
        if (!entry) entry = fallbackEntry;

        // If entry not found (nested include not yet discovered), evaluate parent
        if (!entry) {
          const parent = deps.routesEntries.find(
            (e) =>
              trieResult.sp.startsWith(e.staticPrefix) &&
              e.staticPrefix !== trieResult.sp,
          );
          if (parent) {
            const lazyStart = performance.now();
            deps.evaluateLazyEntry(parent);
            pushMetric?.("match:lazy-eval", lazyStart);
          }
          entry = deps.routesEntries.find(
            (e) => e.staticPrefix === trieResult.sp,
          );
        }
        pushMetric?.("match:entry-resolve", entryStart);

        if (entry) {
          lastFindMatchPathname = pathname;
          lastFindMatchResult = {
            entry,
            routeKey: trieResult.routeKey,
            params: trieResult.params,
            optionalParams: new Set(trieResult.optionalParams || []),
            redirectTo: trieResult.redirectTo,
            ancestry: trieResult.ancestry,
            ...(trieResult.pr ? { pr: true } : {}),
            ...(trieResult.pt ? { pt: true } : {}),
            ...(trieResult.responseType
              ? { responseType: trieResult.responseType }
              : {}),
            ...(trieResult.negotiateVariants
              ? { negotiateVariants: trieResult.negotiateVariants }
              : {}),
            ...(trieResult.rscFirst ? { rscFirst: true } : {}),
          };
          return lastFindMatchResult;
        }
      }
    }

    // Phase 2: Fall back to existing matching (regex iteration)
    const regexStart = performance.now();
    let result = findRouteMatch(pathname, deps.routesEntries);

    // If we hit a lazy entry that needs evaluation, evaluate and retry.
    // Cap iterations to prevent infinite loops from pathological nesting.
    const MAX_LAZY_ITERATIONS = 100;
    let iterations = 0;
    while (isLazyEvaluationNeeded(result)) {
      if (++iterations > MAX_LAZY_ITERATIONS) {
        console.error(
          `[@rangojs/router] Exceeded ${MAX_LAZY_ITERATIONS} lazy evaluation iterations ` +
            `for pathname "${pathname}". This likely indicates circular lazy includes.`,
        );
        lastFindMatchPathname = pathname;
        lastFindMatchResult = null;
        return null;
      }
      deps.evaluateLazyEntry(result.lazyEntry);
      result = findRouteMatch(pathname, deps.routesEntries);
    }
    pushMetric?.("match:regex-fallback", regexStart);

    lastFindMatchPathname = pathname;
    lastFindMatchResult = result;
    return result;
  };
}
