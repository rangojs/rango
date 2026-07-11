import { invariant, RouteNotFoundError } from "../errors";
import { createRouteHelpers } from "../route-definition";
import {
  getContext,
  runWithPrefixes,
  getIsolatedLazyParent,
  type EntryData,
  type MetricsStore,
} from "../server/context";
import MapRootLayout from "../server/root-layout";
import { joinPrefix } from "./pattern-matching.js";
import type { RouteEntry } from "../types";
import type { UrlPatterns } from "../urls";
import {
  isIncludeProvider,
  resolveIncludeModule,
} from "../urls/include-provider.js";
import { VERSION } from "@rangojs/router:version";

// Tags an error thrown while dynamically importing an async include's module
// (`() => import("./routes")`) so loadManifest's outer catch re-raises it as a
// server error rather than masking it as a RouteNotFoundError (404).
const MODULE_LOAD_FAILURE = Symbol.for("rango.moduleLoadFailure");

// Module-level manifest cache: avoids re-executing DSL handler on every request.
// Handler execution is deterministic (components, loaders, middleware are module-level
// stable references), so the resulting EntryData tree can be safely cached and reused
// across requests within the same isolate.
//
// Cache is keyed by (VERSION, routerId, mountIndex, routeKey, isSSR). routeKey is
// REQUIRED in the key: loadManifest() runs the handler with forRoute=routeKey, and
// path-helper.ts prunes (skips registering) every route except forRoute, so the
// resulting Store.manifest is pruned to the requested route — NOT the full include.
// Dropping routeKey would make a sibling route miss and overwrite this entry with its
// own pruned manifest, so alternating sibling requests would thrash (re-run the
// handler every time). Running the include handler once per isolate instead of once
// per route is possible but needs an unpruned manifest cache with prune-on-read — see
// LP1 in docs/internal/matching-and-lazy-discovery.md. VERSION comes from the
// @rangojs/router:version virtual module which Vite invalidates on RSC module HMR.
// When VERSION changes, this module re-evaluates and the cache is recreated empty.
const manifestModuleCache = new Map<string, Map<string, EntryData>>();

/**
 * Clear the module-level manifest cache.
 * Called on HMR to ensure stale handler references are discarded.
 */
export function clearManifestCache(): void {
  manifestModuleCache.clear();
}

export async function loadManifest(
  entry: RouteEntry<any>,
  routeKey: string,
  path: string,
  metricsStore?: MetricsStore,
  isSSR?: boolean,
): Promise<EntryData> {
  // Helper to push a metric entry
  const pushMetric = metricsStore
    ? (label: string, start: number) => {
        metricsStore.metrics.push({
          label,
          duration: performance.now() - start,
          startTime: start - metricsStore.requestStart,
        });
      }
    : undefined;

  const mountIndex = entry.mountIndex;

  // Check module-level cache (persists across requests within same isolate).
  // Include routerId so multi-router setups (host routing) don't share cached
  // EntryData across routers with overlapping mountIndex + routeKey combinations.
  // routeKey is in the key because loadManifest() builds a manifest pruned to
  // forRoute=routeKey (see path-helper.ts) — see the cache comment above.
  const cacheKey = `${VERSION}:${entry.routerId ?? ""}:${mountIndex ?? ""}:${routeKey}:${isSSR ? 1 : 0}`;
  const cached = manifestModuleCache.get(cacheKey);
  if (cached) {
    const cacheStart = performance.now();
    // Set up Store for downstream consumers (segment resolution reads Store.manifest)
    const Store = getContext().getOrCreateStore(routeKey);
    Store.mountIndex = mountIndex;
    Store.isSSR = isSSR;
    if (metricsStore) Store.metrics = metricsStore;
    // Alias the request-scoped Store to the cached Map instead of copying it
    // entry-by-entry. At request time this Store is throwaway (no ambient
    // RangoContext store spans classify->match->render, so getOrCreateStore
    // returns a fresh detached store here), so nothing mutates it in place after
    // loadManifest returns. The fresh path below REASSIGNS Store.manifest rather
    // than clearing it in place, so a later fresh load sharing this Store cannot
    // poison the cached Map.
    Store.manifest = cached;
    pushMetric?.("manifest:cache-hit", cacheStart);
    return cached.get(routeKey)!;
  }

  const storeSetupStart = performance.now();
  const Store = getContext().getOrCreateStore(routeKey);

  Store.mountIndex = mountIndex;
  Store.isSSR = isSSR;

  if (metricsStore) {
    Store.metrics = metricsStore;
  }

  pushMetric?.("manifest:store-setup", storeSetupStart);

  const clearStart = performance.now();
  // Reassign rather than clear() in place: a prior cache-hit may have aliased
  // Store.manifest to a shared module-cache Map (see cache-hit branch above),
  // and clearing it in place would poison that cache. A fresh Map isolates this
  // build; the cache still receives an independent copy at the end.
  Store.manifest = new Map();
  pushMetric?.("manifest:clear", clearStart);

  try {
    // Include mountIndex in namespace to ensure unique cache keys per mount
    const namespaceWithMount =
      mountIndex !== undefined ? `#router.M${mountIndex}` : "#router";

    // For lazy entries, use the captured parent from include() context
    // This ensures routes are registered under the correct layout hierarchy
    const lazyContext =
      entry.lazy && entry.lazyPatterns ? entry.lazyContext : null;
    const parentForContext = lazyContext
      ? getIsolatedLazyParent(
          (lazyContext.parent as EntryData | null) ?? Store.parent,
        )
      : Store.parent;

    // For lazy entries, merge captured counters from include() so the
    // handler's entries get shortCode indices after sibling entries that
    // were created during pattern extraction.  This prevents shortCode
    // collisions between lazy and non-lazy entries under the same parent
    // (e.g., ArticlesLayout and BlogLayout both under NavLayout).
    if (lazyContext?.counters) {
      for (const [key, value] of Object.entries(lazyContext.counters)) {
        Store.counters[key] = Math.max(Store.counters[key] ?? 0, value);
      }
    }

    // Propagate cache profiles for DSL-time cache("profileName") resolution.
    // Non-lazy entries carry profiles directly; lazy entries carry them
    // in the captured lazyContext from include() time. Always write
    // (including clearing to undefined) so a prior lazy build's profile
    // map cannot leak into a later non-lazy build on the same ALS-backed
    // Store — which would otherwise let cache("name") resolve a profile
    // from an unrelated entry.
    Store.cacheProfiles = entry.cacheProfiles ?? lazyContext?.cacheProfiles;

    // Propagate rootScoped from lazyContext so that routes inside
    // nested { name: "sub" } under { name: "" } keep inherited root scope
    // when the manifest is rebuilt on each request. Always write
    // (including clearing to undefined, which makes getRootScoped()
    // return its true default) so a prior lazy build's scope cannot leak
    // into a later non-lazy build on the same ALS-backed Store — which
    // would otherwise mis-register plain routes as non-root-scoped and
    // break dot-local reverse resolution.
    Store.rootScoped = lazyContext?.rootScoped;

    // Propagate includeScope from lazyContext so that direct-descendant
    // shortCodes of this include use the correct scoped counter namespace
    // on every manifest rebuild. Always write (including clearing to
    // undefined) so a prior lazy build's scope cannot leak into a later
    // non-lazy build on the same ALS-backed Store.
    Store.includeScope = lazyContext?.includeScope;

    const handlerExecStart = performance.now();
    const useItems = await getContext().runWithStore(
      Store,
      Store.namespace || namespaceWithMount,
      parentForContext,
      async () => {
        // Create helpers for lazy-loaded handlers that need them
        const helpers = createRouteHelpers();

        // For lazy entries, use lazyPatterns.handler() with proper prefixes.
        // Do NOT wrap in MapRootLayout here: the captured parent chain from
        // pattern extraction already includes the synthetic MapRootLayout
        // parent, so adding another would create an extra level that does
        // not exist in the non-lazy (root handler) path and would produce
        // mismatched shortCodes.
        if (entry.lazy && entry.lazyPatterns) {
          // Resolve an async include provider (`() => import("./routes")`) before
          // running its handler. The match-time precomputed shortcut can skip
          // evaluateLazyEntry's resolution, so render-time must resolve it here;
          // cache the resolved patterns on the entry so later renders reuse them.
          if (isIncludeProvider(entry.lazyPatterns)) {
            try {
              entry.lazyPatterns = resolveIncludeModule(
                await entry.lazyPatterns(),
                entry.staticPrefix,
              ) as unknown as UrlPatterns<any>;
            } catch (err) {
              // A failed dynamic import of a REAL, matched route's module is a
              // server error, not a missing route. Tag it so the outer catch
              // surfaces it as a 5xx instead of masking it as a
              // RouteNotFoundError — which renders the 404 page (monitoring
              // misses the failure and a CDN could cache the 404).
              if (err && typeof err === "object") {
                (err as Record<PropertyKey, unknown>)[MODULE_LOAD_FAILURE] =
                  true;
              }
              throw err;
            }
          }
          const lazyPatterns = entry.lazyPatterns as UrlPatterns<any>;
          const includePrefix = (entry as any)._lazyPrefix || "";
          // Slash-collapsing join so a trailing-slash parent prefix does not
          // bake a double slash into the registered route patterns (must match
          // the same join in evaluateLazyEntry / the build-time runWithPrefixes).
          const fullPrefix = joinPrefix(lazyContext?.urlPrefix, includePrefix);

          if (fullPrefix || lazyContext?.namePrefix) {
            return runWithPrefixes(fullPrefix, lazyContext?.namePrefix, () =>
              lazyPatterns.handler(),
            );
          }
          return lazyPatterns.handler();
        }

        let promiseResult: Promise<any> | null = null;
        const wrappedItems = helpers.layout(MapRootLayout, () => {
          const result = entry.handler();
          if (result instanceof Promise) {
            promiseResult = result;
            return [];
          }
          return result;
        });

        if (promiseResult !== null) {
          const load = await (promiseResult as Promise<any>);
          if (load && typeof load === "object" && "default" in load) {
            // Promise<{ default: () => Array }> - e.g., dynamic import
            if (typeof load.default !== "function") {
              throw new Error(
                `[@rangojs/router] Unsupported async handler: { default } must be a function, ` +
                  `got ${typeof load.default}. Use () => import('./urls') for lazy loading.`,
              );
            }
            return (load.default as (h?: any) => any)(helpers);
          }
          if (typeof load === "function") {
            // Promise<() => Array>
            return (load as (h?: any) => any)(helpers);
          }
          // Reject unsupported async handler results. Supported shapes are:
          //   Promise<{ default: fn }> — dynamic import
          //   Promise<fn> — lazy function
          // Direct Promise<Array> is not supported; use a function wrapper.
          throw new Error(
            `[@rangojs/router] Unsupported async handler result (${typeof load}). ` +
              `Lazy route handlers must resolve to a function or { default: fn }, ` +
              `not a direct array. Wrap your handler: () => import('./urls') or ` +
              `() => Promise.resolve((h) => [...])`,
          );
        }

        return [wrappedItems].flat(3);
      },
    );
    pushMetric?.("manifest:handler-exec", handlerExecStart);

    const validationStart = performance.now();
    invariant(
      useItems && useItems.length > 0,
      "Did not receive any handler from router.map()",
    );
    // For non-lazy entries the root handler is wrapped in MapRootLayout,
    // so the result always contains a layout item.  Lazy entries run the
    // included patterns handler directly (no MapRootLayout wrapper) so
    // we skip this check -- the layout is in the captured parent chain.
    if (!lazyContext) {
      invariant(
        useItems.some((item: { type: string }) => item.type === "layout"),
        "Top-level handler must be a layout",
      );
    }

    invariant(
      Store.manifest.has(routeKey),
      `Route must be registered for ${routeKey}`,
    );
    pushMetric?.("manifest:validation", validationStart);

    // Cache manifest for future requests in this isolate
    manifestModuleCache.set(cacheKey, new Map(Store.manifest));

    return Store.manifest.get(routeKey)!;
  } catch (e) {
    // A tagged async-include module-load failure is a server error for a REAL
    // matched route — re-raise it unchanged (becomes a 5xx) instead of masking
    // it as a RouteNotFoundError (which renders/caches a 404).
    if (
      e &&
      typeof e === "object" &&
      (e as Record<PropertyKey, unknown>)[MODULE_LOAD_FAILURE]
    ) {
      throw e;
    }
    throw new RouteNotFoundError(
      `Failed to load route handlers for ${path}: ${(e as Error).message}`,
      {
        cause: {
          error: e,
          state: {
            path,
            routeKey,
          },
        },
      },
    );
  }
}
