import type { ResolvedSegment } from "./types.js";

/**
 * Merge partial loader data from server with cached loader data.
 *
 * During partial revalidation (stale or action), the server may return only
 * some loaders that pass the revalidation check. The component still needs
 * all loader data, so we merge fresh data with cached data.
 *
 * @param fromServer - Segment returned from server with partial loaders
 * @param fromCache - Cached segment with full loader data
 * @returns Merged segment with complete loader data
 */
export function mergeSegmentLoaders(
  fromServer: ResolvedSegment,
  fromCache: ResolvedSegment
): ResolvedSegment {
  const serverLoaderNames = fromServer.loaderNames || [];
  const cachedLoaderNames = fromCache.loaderNames || [];

  console.log(
    `[Browser] Merging partial loaders: server has ${serverLoaderNames.join(", ")}, cache has ${cachedLoaderNames.join(", ")}`
  );

  return {
    ...fromCache,
    // Keep cached component (server's might be a fresh Promise that needs the loaders)
    component: fromCache.component,
    // Merge loader data - await both and combine
    loaderDataPromise: Promise.all([
      fromServer.loaderDataPromise!,
      fromCache.loaderDataPromise!,
    ]).then(([newData, cachedData]) => {
      // Build merged array: use new data for updated loaders, cached for rest
      return cachedLoaderNames.map((name: string, i: number) => {
        const newIndex = serverLoaderNames.indexOf(name);
        if (newIndex !== -1) {
          return (newData as any[])[newIndex]; // Use fresh data
        }
        return (cachedData as any[])[i]; // Use cached data
      });
    }),
    // Keep all loader names from cache
    loaderNames: fromCache.loaderNames,
  };
}

/**
 * Check if segments need loader merging during partial revalidation.
 *
 * Returns true when:
 * - Server returned fewer loaders than cached (partial revalidation)
 * - Both segments have loader data promises
 */
export function needsLoaderMerge(
  fromServer: ResolvedSegment,
  fromCache: ResolvedSegment | undefined
): fromCache is ResolvedSegment {
  return !!(
    fromCache &&
    fromServer.loaderNames &&
    fromCache.loaderNames &&
    fromServer.loaderNames.length < fromCache.loaderNames.length &&
    fromServer.loaderDataPromise &&
    fromCache.loaderDataPromise
  );
}
