/**
 * Router Manifest Loading
 *
 * Handles lazy loading and validation of route manifests.
 */

import { invariant, RouteNotFoundError } from "../errors";
import { createRouteHelpers } from "../route-definition";
import { getContext, runWithPrefixes, type EntryData, type MetricsStore } from "../server/context";
import MapRootLayout from "../server/root-layout";
import type { RouteEntry } from "../types";
import type { UrlPatterns } from "../urls";

// Runtime ancestry cache: shortCodes captured from actual loadManifest execution.
// Build-time ancestry (from generateManifest) uses different contexts than runtime
// (fresh parent=null vs lazyContext.parent, different mountIndex presence), causing
// shortCode divergence. Runtime cache guarantees correct ancestry for pruning.
const runtimeAncestryCache = new Map<string, string[]>();

// Module-level manifest cache: avoids re-executing DSL handler on every request.
// Handler execution is deterministic (components, loaders, middleware are module-level
// stable references), so the resulting EntryData tree can be safely cached and reused
// across requests within the same isolate. Cache is keyed by (mountIndex, routeKey, isSSR)
// since isSSR affects loading() property for routes using ssr:false.
const manifestModuleCache = new Map<string, Map<string, EntryData>>();

/**
 * Load manifest from route entry with AsyncLocalStorage context
 * Handles lazy imports, unwrapping, and validation
 *
 * Results are cached at module level after first execution. Subsequent calls
 * for the same (routeKey, isSSR) within the same isolate return cached data
 * without re-executing the DSL handler.
 */
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

  // Check module-level cache (persists across requests within same isolate)
  const cacheKey = `${mountIndex ?? ''}:${routeKey}:${isSSR ? 1 : 0}`;
  const cached = manifestModuleCache.get(cacheKey);
  if (cached) {
    const cacheStart = performance.now();
    // Set up Store for downstream consumers (segment resolution reads Store.manifest)
    const Store = getContext().getOrCreateStore(routeKey);
    Store.mountIndex = mountIndex;
    Store.isSSR = isSSR;
    if (metricsStore) Store.metrics = metricsStore;
    // Restore cached manifest into Store
    for (const [k, v] of cached) {
      Store.manifest.set(k, v);
    }
    pushMetric?.("manifest:cache-hit", cacheStart);
    return cached.get(routeKey)!;
  }

  const storeSetupStart = performance.now();
  const Store = getContext().getOrCreateStore(routeKey);

  // Set mount index in store for unique shortCode prefixes
  Store.mountIndex = mountIndex;

  // Set isSSR flag so loading() can check if we're in SSR
  Store.isSSR = isSSR;

  // Attach metrics store to context if provided
  if (metricsStore) {
    Store.metrics = metricsStore;
  }

  // Set ancestry for layout pruning using runtime-captured ancestry only.
  // Build-time ancestry (from trie or routeAncestry map) uses different contexts
  // than runtime (different parent chains, mountIndex presence), so shortCodes
  // diverge. Only use ancestry captured from a previous loadManifest run.
  const runtimeAncestry = runtimeAncestryCache.get(routeKey);
  if (runtimeAncestry) {
    Store.ancestry = new Set(runtimeAncestry);
  }
  pushMetric?.("manifest:store-setup", storeSetupStart);

  // Clear manifest before rebuilding to prevent stale entry mutations
  const clearStart = performance.now();
  Store.manifest.clear();
  pushMetric?.("manifest:clear", clearStart);

  try {
    // Include mountIndex in namespace to ensure unique cache keys per mount
    const namespaceWithMount = mountIndex !== undefined
      ? `#router.M${mountIndex}`
      : "#router";

    // For lazy entries, use the captured parent from include() context
    // This ensures routes are registered under the correct layout hierarchy
    const lazyContext = entry.lazy && entry.lazyPatterns ? entry.lazyContext : null;
    const parentForContext = lazyContext?.parent as EntryData | null ?? Store.parent;

    const handlerExecStart = performance.now();
    const useItems = await getContext().runWithStore(
      Store,
      Store.namespace || namespaceWithMount,
      parentForContext,
      async () => {
        // Create helpers for lazy-loaded handlers that need them
        const helpers = createRouteHelpers();

        // For lazy entries, use lazyPatterns.handler() with proper prefixes
        if (entry.lazy && entry.lazyPatterns) {
          const lazyPatterns = entry.lazyPatterns as UrlPatterns<any>;
          const includePrefix = (entry as any)._lazyPrefix || "";
          const fullPrefix = (lazyContext?.urlPrefix || "") + includePrefix;

          // Wrap in root layout and run with prefixes
          const wrappedItems = helpers.layout(MapRootLayout, () => {
            if (fullPrefix || lazyContext?.namePrefix) {
              return runWithPrefixes(
                fullPrefix,
                lazyContext?.namePrefix,
                () => lazyPatterns.handler()
              );
            }
            return lazyPatterns.handler();
          });

          return [wrappedItems].flat(3);
        }

        // Wrap handler execution in root layout so routes get correct parent
        // This ensures all routes are registered with the layout as their parent
        let promiseResult: Promise<any> | null = null;
        const wrappedItems = helpers.layout(MapRootLayout, () => {
          const result = entry.handler();
          if (result instanceof Promise) {
            // Lazy handler detected - capture promise for async handling
            promiseResult = result;
            return []; // Return empty, we'll discard this wrapped result
          }
          return result;
        });

        // Handle lazy (Promise-based) handlers
        if (promiseResult !== null) {
          const load = await (promiseResult as Promise<any>);
          if (
            load &&
            load !== null &&
            typeof load === "object" &&
            "default" in load
          ) {
            // Promise<{ default: () => Array }> - e.g., dynamic import
            // Lazy-loaded handlers may need helpers (passed as optional arg)
            return (load.default as (h?: any) => any)(helpers);
          }
          if (typeof load === "function") {
            // Promise<() => Array>
            return (load as (h?: any) => any)(helpers);
          }
          // Promise<Array> - direct array from async handler
          return load;
        }

        // Inline handler - routes were registered with correct parent inside layout
        return [wrappedItems].flat(3);
      }
    );
    pushMetric?.("manifest:handler-exec", handlerExecStart);

    const validationStart = performance.now();
    invariant(
      useItems && useItems.length > 0,
      "Did not receive any handler from router.map()"
    );
    invariant(
      useItems.some((item: { type: string }) => item.type === "layout"),
      "Top-level handler must be a layout"
    );

    invariant(
      Store.manifest.has(routeKey),
      `Route must be registered for ${routeKey}`
    );
    pushMetric?.("manifest:validation", validationStart);

    // Capture runtime ancestry on first successful load for future pruning.
    // Walk the parent chain from the route entry to build the correct ancestry
    // using the actual runtime shortCodes.
    const ancestryStart = performance.now();
    if (!runtimeAncestryCache.has(routeKey)) {
      const routeEntry = Store.manifest.get(routeKey)!;
      const ancestry: string[] = [];
      let current: EntryData | null = routeEntry;
      while (current) {
        ancestry.unshift(current.shortCode);
        current = current.parent;
      }
      runtimeAncestryCache.set(routeKey, ancestry);
    }
    pushMetric?.("manifest:ancestry-capture", ancestryStart);

    // Cache manifest for future requests in this isolate
    manifestModuleCache.set(cacheKey, new Map(Store.manifest));

    return Store.manifest.get(routeKey)!;
  } catch (e) {
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
      }
    );
  }
}
