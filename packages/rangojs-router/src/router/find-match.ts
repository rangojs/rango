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
        let candidateError: unknown;
        let candidateFailed = false;

        for (const e of deps.routesEntries) {
          if (e.staticPrefix !== trieResult.sp) continue;
          if (!fallbackEntry) fallbackEntry = e;
          try {
            const ev = deps.evaluateLazyEntry(e);
            if (ev) await ev;
          } catch (err) {
            // Multiple async includes can share one collapsed static prefix, so
            // this loop may evaluate a candidate that is NOT the route's owner.
            // Remember the failure and keep scanning: if another candidate owns
            // the route, this sibling's failure is correctly isolated (its
            // _lazyInflight was cleared, so a later request retries). But if NO
            // candidate ends up owning it, the failing one WAS the owner — a
            // real, trie-matched route whose module failed to import — and we
            // rethrow below as a 5xx rather than silently 404ing (see finding 3:
            // owner failure must stay loud).
            candidateError = err;
            candidateFailed = true;
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

        // The trie matched this route, so it EXISTS. If no same-prefix candidate
        // could own it AND one failed to load, the owning module is the one that
        // threw — surface the module failure as a 5xx, not the misleading 404 a
        // fallthrough would give.
        if (!entry && candidateFailed) {
          throw candidateError;
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
      try {
        const ev = deps.evaluateLazyEntry(result.lazyEntry);
        if (ev) await ev;
      } catch (err) {
        // If the trie matched this pathname, the route is REAL and this lazy
        // entry owns (part of) it — a module-load failure is a genuine error, so
        // propagate it as a 5xx. If the trie did NOT match, this is a
        // genuinely-unmatched pathname (a typo, a bot probe): its 404 must not be
        // upgraded to a 500 just because some lazy include — e.g. a failing root
        // `include("/")` — happened to need evaluating while we probed. Isolate
        // and fall through to the 404 (finding 4: the two match phases agree —
        // owner failure is loud, unmatched stays 404).
        if (trieMatched) throw err;
        console.error(
          `[@rangojs/router] include at "${result.lazyEntry.staticPrefix}" ` +
            `failed to load while resolving unmatched path "${pathname}": ` +
            `${(err as Error)?.message ?? String(err)}`,
        );
        lastFindMatchPathname = pathname;
        lastFindMatchResult = null;
        return null;
      }
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
