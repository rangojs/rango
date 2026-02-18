/**
 * Client Segment Runtime - Cache Operations
 *
 * Pure functions for cache state mutations. These are called by the reducer;
 * cache operations are state mutations, not commands.
 *
 * Depends only on types.ts.
 */

import type {
  RouteSnapshot,
  CacheEntry,
} from "./types.js";

// ---------------------------------------------------------------------------
// Cache key derivation
// ---------------------------------------------------------------------------

/**
 * Derive a cache key from URL and optional intercept source.
 * Centralized: every cache read/write goes through this.
 */
export function cacheKey(url: string, interceptSourceUrl?: string | null): string {
  try {
    const parsed = new URL(url);
    const base = parsed.pathname + parsed.search;
    return interceptSourceUrl ? base + ":intercept" : base;
  } catch {
    // Fallback for relative URLs or malformed input
    const base = url.split("?")[0] + (url.includes("?") ? "?" + url.split("?")[1]?.split("#")[0] : "");
    return interceptSourceUrl ? base + ":intercept" : base;
  }
}

// ---------------------------------------------------------------------------
// Cache read
// ---------------------------------------------------------------------------

/**
 * Look up a cache entry by key.
 */
export function cacheGet(
  cache: Map<string, CacheEntry>,
  key: string
): CacheEntry | undefined {
  return cache.get(key);
}

// ---------------------------------------------------------------------------
// Cache write with LRU eviction
// ---------------------------------------------------------------------------

/**
 * Write a snapshot to cache, evicting LRU entries if needed.
 * Never evicts the entry matching `currentKey`.
 *
 * Returns a new Map (does not mutate input).
 */
export function cacheWrite(
  cache: Map<string, CacheEntry>,
  key: string,
  snapshot: RouteSnapshot,
  stale: boolean,
  maxSize: number,
  currentKey: string
): Map<string, CacheEntry> {
  const next = new Map(cache);

  // Delete first to reset insertion order (LRU tracking via Map order)
  next.delete(key);
  next.set(key, { snapshot, stale });

  // Evict oldest entries if over max size
  while (next.size > maxSize) {
    let evicted = false;
    for (const [k] of next) {
      if (k !== currentKey && k !== key) {
        next.delete(k);
        evicted = true;
        break;
      }
    }
    if (!evicted) break; // Safety: all entries are protected
  }

  return next;
}

// ---------------------------------------------------------------------------
// Cache stale marking
// ---------------------------------------------------------------------------

/**
 * Mark a cache entry as stale. Returns a new Map if the entry exists.
 */
export function cacheMarkStale(
  cache: Map<string, CacheEntry>,
  key: string
): Map<string, CacheEntry> {
  const entry = cache.get(key);
  if (!entry || entry.stale) return cache; // No change needed

  const next = new Map(cache);
  next.set(key, { ...entry, stale: true });
  return next;
}

// ---------------------------------------------------------------------------
// Shared-segment freshness
// ---------------------------------------------------------------------------

/**
 * Merge fresh segment data from current snapshot into a cached snapshot.
 * When a layout is mounted on both the current page and the cached page,
 * the current page's version is fresher (it may have been updated by actions).
 *
 * Returns a new snapshot with shared segments updated.
 */
export function mergeSharedSegmentFreshness(
  cached: RouteSnapshot,
  current: RouteSnapshot
): RouteSnapshot {
  const currentIds = new Set(current.segmentIndex.keys());
  let changed = false;
  const mergedSegments = cached.segments.map((seg) => {
    if (currentIds.has(seg.id)) {
      const currentIdx = current.segmentIndex.get(seg.id)!;
      const currentSeg = current.segments[currentIdx];
      // Use current segment's data but preserve cached structural properties
      if (currentSeg !== seg) {
        changed = true;
        return {
          ...currentSeg,
          loading: seg.loading, // Preserve structural property
          mountPath: seg.mountPath, // Preserve structural property
        };
      }
    }
    return seg;
  });

  if (!changed) return cached;

  // Rebuild index for merged segments
  const segmentIndex = new Map<string, number>();
  for (let i = 0; i < mergedSegments.length; i++) {
    segmentIndex.set(mergedSegments[i].id, i);
  }

  return {
    ...cached,
    segments: mergedSegments,
    segmentIndex,
    updatedAt: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Cache clear
// ---------------------------------------------------------------------------

/**
 * Clear all cache entries. Returns a new empty Map.
 */
export function cacheClear(): Map<string, CacheEntry> {
  return new Map();
}
