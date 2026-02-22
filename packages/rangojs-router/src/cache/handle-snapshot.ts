/**
 * Handle Snapshot
 *
 * Capture and restore handle data for cached segments.
 * Handle data (breadcrumbs, metadata from ctx.use(Handle)) is collected
 * during segment resolution and stored alongside cached segments.
 */

import type { ResolvedSegment } from "../types.js";
import type { HandleStore } from "../server/handle-store.js";
import type { SegmentHandleData } from "./types.js";

/**
 * Capture handle data for a set of segments from the handle store.
 * Used when caching segments to preserve their handle data.
 */
export function captureHandles(
  segments: ResolvedSegment[],
  handleStore: HandleStore,
): Record<string, SegmentHandleData> {
  const handles: Record<string, SegmentHandleData> = {};
  for (const seg of segments) {
    handles[seg.id] = handleStore.getDataForSegment(seg.id);
  }
  return handles;
}

/**
 * Restore handle data from a cached snapshot into the handle store.
 * Used when serving cached segments to replay their handle data.
 */
export function restoreHandles(
  handles: Record<string, SegmentHandleData>,
  handleStore: HandleStore,
): void {
  for (const [segId, segHandles] of Object.entries(handles)) {
    if (Object.keys(segHandles).length > 0) {
      handleStore.replaySegmentData(segId, segHandles);
    }
  }
}
