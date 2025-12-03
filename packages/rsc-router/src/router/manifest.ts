/**
 * Router Manifest Loading
 *
 * Handles lazy loading and validation of route manifests.
 */

import { invariant, RouteNotFoundError } from "../errors";
import { getContext, type EntryData, type MetricsStore } from "../server/context";
import type { RouteEntry } from "../types";

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
  const Store = getContext().getOrCreateStore(routeKey);

  // Set mount index in store for unique shortCode prefixes
  Store.mountIndex = entry.mountIndex;

  // Set isSSR flag so loading() can check if we're in SSR
  Store.isSSR = isSSR;

  // Attach metrics store to context if provided
  if (metricsStore) {
    Store.metrics = metricsStore;
  }

  // Clear manifest before rebuilding to prevent stale entry mutations
  Store.manifest.clear();

  try {
    const useItems = await getContext().runWithStore(
      Store,
      Store.namespace || "#router",
      Store.parent,
      async () => {
        const load = await entry.handler();
        if (
          load &&
          load !== null &&
          typeof load === "object" &&
          "default" in load
        ) {
          return load.default();
        }
        if (typeof load === "function") {
          return load();
        }
        return load;
      }
    );

    invariant(
      useItems && useItems.length > 0,
      "Did not receive any handler from router.map()"
    );
    invariant(
      useItems.some((item) => item.type === "layout"),
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
