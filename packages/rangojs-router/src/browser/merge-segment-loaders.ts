import type { ResolvedSegment } from "./types.js";
import { debugLog } from "./logging.js";

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
  fromCache: ResolvedSegment,
): ResolvedSegment {
  const serverLoaderIds = fromServer.loaderIds || [];
  const cachedLoaderIds = fromCache.loaderIds || [];

  debugLog(
    `[Browser] Merging partial loaders: server has ${serverLoaderIds.join(", ")}, cache has ${cachedLoaderIds.join(", ")}`,
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
      return cachedLoaderIds.map((id: string, i: number) => {
        const newIndex = serverLoaderIds.indexOf(id);
        if (newIndex !== -1) {
          return (newData as any[])[newIndex]; // Use fresh data
        }
        return (cachedData as any[])[i]; // Use cached data
      });
    }),
    // Keep all loader IDs from cache
    loaderIds: fromCache.loaderIds,
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
  fromCache: ResolvedSegment | undefined,
): fromCache is ResolvedSegment {
  return !!(
    fromCache &&
    fromServer.loaderIds &&
    fromCache.loaderIds &&
    fromServer.loaderIds.length < fromCache.loaderIds.length &&
    fromServer.loaderDataPromise &&
    fromCache.loaderDataPromise
  );
}

/**
 * Insert diff segments that aren't in the matched array into allSegments.
 *
 * During consolidation fetch for concurrent actions, loader segments may be
 * excluded from the request. The server returns them in the diff but not in
 * the matched array. This function inserts them at the correct position
 * (after their parent layout segment).
 *
 * Loader segment IDs follow the pattern: {parentLayoutId}D{index}.{loaderId}
 * Example: M9L0L1D0.actionCounter has parent layout M9L0L1
 *
 * @param allSegments - Mutable array of segments to insert into
 * @param diff - Array of segment IDs that changed (from server response)
 * @param matchedIdSet - Set of segment IDs from matched array
 * @param newSegmentMap - Map of segment ID to segment data from server
 */
export function insertMissingDiffSegments(
  allSegments: ResolvedSegment[],
  diff: string[] | undefined,
  matchedIdSet: Set<string>,
  newSegmentMap: Map<string, ResolvedSegment>,
): void {
  if (!diff || diff.length === 0) return;

  // Track how many siblings have been inserted per parent so each new
  // sibling goes after the last one rather than always at parentIndex + 1
  // (which would reverse the server order).
  const insertedPerParent = new Map<string, number>();

  diff.forEach((diffId: string) => {
    if (!matchedIdSet.has(diffId)) {
      const fromServer = newSegmentMap.get(diffId);
      if (fromServer) {
        // Loader segment IDs have pattern like M9L0L1D0.actionCounter
        // Parent layout ID is the prefix before D\d+ (e.g., M9L0L1)
        const loaderMatch = diffId.match(/^(.+?)D\d+\./);
        if (loaderMatch) {
          const parentLayoutId = loaderMatch[1];
          const parentIndex = allSegments.findIndex(
            (s) => s.id === parentLayoutId,
          );
          if (parentIndex !== -1) {
            const alreadyInserted = insertedPerParent.get(parentLayoutId) ?? 0;
            const insertAt = parentIndex + 1 + alreadyInserted;
            allSegments.splice(insertAt, 0, fromServer);
            insertedPerParent.set(parentLayoutId, alreadyInserted + 1);
            debugLog(
              `[Browser] Inserted diff segment ${diffId} after ${parentLayoutId}`,
            );
          } else {
            // Fallback: append to end if parent not found
            allSegments.push(fromServer);
            console.warn(
              `[Browser] Appended diff segment ${diffId} (parent ${parentLayoutId} not found)`,
            );
          }
        } else {
          // Non-loader diff segment not in matched - append to end
          allSegments.push(fromServer);
          debugLog(`[Browser] Appended diff segment ${diffId}`);
        }
      }
    }
  });
}
