import type { ResolvedSegment } from "./types.js";
import { debugLog, IS_BROWSER_DEBUG } from "./logging.js";

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
