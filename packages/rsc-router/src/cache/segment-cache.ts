/**
 * Segment Cache Types
 *
 * Re-exports cache types for backwards compatibility.
 * Caching logic is now handled by CacheScope in cache-scope.ts
 */

import type {
  SegmentHandleData,
  CachedEntryResult,
  SegmentCacheProvider,
} from "./types.js";

// Re-export types for convenience
export type { SegmentHandleData, CachedEntryResult, SegmentCacheProvider };
