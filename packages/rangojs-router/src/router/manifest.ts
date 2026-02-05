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

/**
 * Load manifest from route entry with AsyncLocalStorage context
 * Handles lazy imports, unwrapping, and validation
 *
 * Note: We don't cache manifests at the module level because includes are
 * lazily evaluated. Caching an incomplete manifest would cause cache misses
 * for routes in not-yet-evaluated includes.
 */
export async function loadManifest(
  entry: RouteEntry<any>,
  routeKey: string,
  path: string,
  metricsStore?: MetricsStore,
  isSSR?: boolean
): Promise<EntryData> {
  const mountIndex = entry.mountIndex;
  const Store = getContext().getOrCreateStore(routeKey);

  // Set mount index in store for unique shortCode prefixes
  Store.mountIndex = mountIndex;

  // Set isSSR flag so loading() can check if we're in SSR
  Store.isSSR = isSSR;

  // Attach metrics store to context if provided
  if (metricsStore) {
    Store.metrics = metricsStore;
  }

  // Clear manifest before rebuilding to prevent stale entry mutations
  Store.manifest.clear();

  try {
    // Include mountIndex in namespace to ensure unique cache keys per mount
    const namespaceWithMount = mountIndex !== undefined
      ? `#router.M${mountIndex}`
      : "#router";

    // For lazy entries, use the captured parent from include() context
    // This ensures routes are registered under the correct layout hierarchy
    const lazyContext = entry.lazy && entry.lazyPatterns ? entry.lazyContext : null;
    const parentForContext = lazyContext?.parent as EntryData | null ?? Store.parent;

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
