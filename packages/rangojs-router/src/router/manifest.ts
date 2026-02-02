/**
 * Router Manifest Loading
 *
 * Handles lazy loading and validation of route manifests.
 */

import { invariant, RouteNotFoundError } from "../errors";
import { createRouteHelpers } from "../route-definition";
import { getContext, type EntryData, type MetricsStore } from "../server/context";
import MapRootLayout from "../server/root-layout";
import type { RouteEntry } from "../types";

/**
 * Module-level cache for manifests per mount index.
 * Only used in production - dev mode skips caching for HMR support.
 */
const manifestCache = new Map<number, Map<string, EntryData>>();

/**
 * Load manifest from route entry with AsyncLocalStorage context
 * Handles lazy imports, unwrapping, and validation
 */
export async function loadManifest(
  entry: RouteEntry<any>,
  routeKey: string,
  path: string,
  metricsStore?: MetricsStore,
  isSSR?: boolean
): Promise<EntryData> {
  const mountIndex = entry.mountIndex;
  const isDev = process.env.NODE_ENV !== "production";

  // In production, check cache first
  if (!isDev) {
    const cachedManifest = manifestCache.get(mountIndex);
    if (cachedManifest && cachedManifest.has(routeKey)) {
      return cachedManifest.get(routeKey)!;
    }
  }

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

    const useItems = await getContext().runWithStore(
      Store,
      Store.namespace || namespaceWithMount,
      Store.parent,
      async () => {
        // Create helpers for lazy-loaded handlers that need them
        const helpers = createRouteHelpers();

        // Call handler - urls() API handlers don't need helpers,
        // legacy map() handlers ignore extra args
        const result = entry.handler();

        // Handle based on return type
        if (result instanceof Promise) {
          // Lazy: () => import(...) - returns Promise
          const load = await result;
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

        // Inline: ({ route }) => [...] - returns Array directly
        // Wrap with layout (like map() from route-definition does)
        // Flatten nested arrays from layout/route definitions
        return [helpers.layout(MapRootLayout, () => result)].flat(3);
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

    // Cache manifest in production after successful build
    if (!isDev) {
      manifestCache.set(mountIndex, new Map(Store.manifest));
    }

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
