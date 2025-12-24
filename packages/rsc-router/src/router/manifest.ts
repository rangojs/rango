/**
 * Router Manifest Loading
 *
 * Handles lazy loading and validation of route manifests.
 */

import { invariant, RouteNotFoundError } from "../errors";
import { getContext, type EntryData, type MetricsStore } from "../server/context";
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
