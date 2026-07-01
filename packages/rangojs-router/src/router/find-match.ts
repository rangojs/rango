import { tryTrieMatch } from "./trie-matching.js";
import { getRouterTrie } from "../route-map-builder.js";
import {
  findMatch as findRouteMatch,
  isLazyEvaluationNeeded,
  type RouteMatchResult,
} from "./pattern-matching.js";
import type { MetricsStore } from "../server/context";
import type { RouteEntry } from "../types";

// The single-entry cache is module-lifetime, keyed only on pathname, so the same
// result object is handed to every same-pathname request. ctx.params aliases
// this object, so handlers mutating it would corrupt the cache for later requests.
// Clone params; entry/flags are read-only and shared safely.
function cloneMatchResult<TEnv>(
  r: RouteMatchResult<TEnv> | null,
): RouteMatchResult<TEnv> | null {
  return r ? { ...r, params: { ...r.params } } : null;
}

export interface FindMatchDeps<TEnv = any> {
  routesEntries: RouteEntry<TEnv>[];
  // Returns a Promise only when it had to resolve an async include provider
  // (`() => import()`); void for eager/precomputed includes, so the per-entry
  // match loop pays no microtask in the common case.
  evaluateLazyEntry: (entry: RouteEntry<TEnv>) => void | Promise<void>;
  routerId: string;
}

/**
 * Create a findMatch function bound to router state.
 * Includes single-entry cache to avoid redundant matching within the same request.
 *
 * Async because a lazy include may be backed by an async provider
 * (`() => import("./routes")`) that must be resolved before its routes can be
 * matched. The hot path is unaffected: `await` only suspends on the first
 * request to a not-yet-loaded dynamic include; eager routes resolve in the same
 * microtask. Every caller already runs inside an async match pipeline.
 */
export function createFindMatch<TEnv = any>(
  deps: FindMatchDeps<TEnv>,
): (
  pathname: string,
  ms?: MetricsStore,
) => Promise<RouteMatchResult<TEnv> | null> {
  // Single-entry cache for findMatch to avoid redundant matching within the same request.
  // previewMatch and match both call findMatch with the same pathname — this ensures
  // the route matching work (which may check thousands of routes) only happens once.
  let lastFindMatchPathname: string | null = null;
  let lastFindMatchResult: RouteMatchResult<TEnv> | null = null;

  return async function findMatch(
    pathname: string,
    ms?: MetricsStore,
  ): Promise<RouteMatchResult<TEnv> | null> {
    if (lastFindMatchPathname === pathname) {
      return cloneMatchResult(lastFindMatchResult);
    }

    const pushMetric = ms
      ? (label: string, start: number) => {
          ms.metrics.push({
            label,
            duration: performance.now() - start,
            startTime: start - ms.requestStart,
          });
        }
      : undefined;

    const routeTrie = getRouterTrie(deps.routerId);
    let trieMatched = false;
    if (routeTrie) {
      const trieStart = performance.now();
      const trieResult = tryTrieMatch(routeTrie, pathname);
      pushMetric?.("match:trie", trieStart);

      if (trieResult) {
        trieMatched = true;
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
          try {
            const ev = deps.evaluateLazyEntry(e);
            if (ev) await ev;
          } catch (err) {
            // Multiple async includes can share one collapsed static prefix, so
            // this loop may evaluate a candidate that is not the route's owner.
            // A failing async provider (`() => import()` rejected) for one such
            // candidate must not throw out of findMatch and break the sibling
            // include that actually owns the route. Skip it — its _lazyInflight
            // was cleared, so a later request retries — and keep scanning.
            console.error(
              `[@rangojs/router] include at "${e.staticPrefix}" failed to load: ` +
                `${(err as Error)?.message ?? String(err)}`,
            );
            continue;
          }
          if (
            e.routes &&
            trieResult.routeKey in (e.routes as Record<string, unknown>)
          ) {
            entry = e;
            break;
          }
        }

        if (!entry) entry = fallbackEntry;

        if (!entry) {
          const parent = deps.routesEntries.find(
            (e) =>
              trieResult.sp.startsWith(e.staticPrefix) &&
              e.staticPrefix !== trieResult.sp,
          );
          if (parent) {
            const lazyStart = performance.now();
            const ev = deps.evaluateLazyEntry(parent);
            if (ev) await ev;
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
            redirectTo: trieResult.redirectTo,
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
          return cloneMatchResult(lastFindMatchResult);
        }
      }
    }

    const regexStart = performance.now();
    let result = findRouteMatch(pathname, deps.routesEntries);

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
      const ev = deps.evaluateLazyEntry(result.lazyEntry);
      if (ev) await ev;
      result = findRouteMatch(pathname, deps.routesEntries);
    }
    pushMetric?.("match:regex-fallback", regexStart);

    // The trie is the single source of truth and is built before findMatch in
    // both dev (handler rebuild) and production (ensureRouterManifest). If the
    // trie was present yet the regex fallback resolved a real match, the trie
    // has a gap (e.g. a route shape it cannot represent) and dev/prod could
    // diverge if the trie were ever absent. Surface it in dev; folded out in
    // production builds.
    //
    // Suppress when the trie DID match (`trieMatched`): that path falls through
    // to the regex fallback only on the first request to a not-yet-spliced lazy
    // entry (e.g. a 2+-level nested include whose deeper parent has not been
    // evaluated). The trie knew the route; runtime lazy discovery simply lagged.
    // That is the supported lazy-include flow, not a trie gap, so warning on it
    // is a false positive (it manufactures bug reports and erodes the signal).
    if (
      process.env.NODE_ENV !== "production" &&
      routeTrie &&
      !trieMatched &&
      result &&
      !isLazyEvaluationNeeded(result)
    ) {
      console.warn(
        `[@rangojs/router] Route "${pathname}" resolved via the regex fallback ` +
          `even though the route trie was present. The trie should be the single ` +
          `matching source of truth; this indicates a trie gap. Please report this ` +
          `with your route configuration.`,
      );
    }

    lastFindMatchPathname = pathname;
    lastFindMatchResult = result;
    return cloneMatchResult(result);
  };
}
