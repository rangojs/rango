/**
 * Tag Store Registry
 *
 * Tracks all SegmentCacheStore instances that have received tagged writes.
 * revalidateTag() uses this to invalidate across all stores, not just
 * the app-level ctx._cacheStore.
 *
 * Without this, cache({ store: customStore, tags: ["catalog"] }) entries
 * would never be invalidated because revalidateTag() only knew about
 * the default store.
 *
 * @internal
 */

import type { SegmentCacheStore } from "./types.js";

const taggedStores = new Set<SegmentCacheStore>();

/**
 * Register a store that has received a tagged write.
 * Called by write paths (CacheScope, cache-runtime, handler)
 * when tags are present.
 *
 * @internal
 */
export function registerTaggedStore(store: SegmentCacheStore): void {
  taggedStores.add(store);
}

/**
 * Get all stores that have ever received tagged writes.
 * Used by revalidateTag() to invalidate across all stores.
 *
 * @internal
 */
export function getTaggedStores(): ReadonlySet<SegmentCacheStore> {
  return taggedStores;
}

/**
 * Clear the registry. For testing only.
 * @internal
 */
export function resetTagStoreRegistry(): void {
  taggedStores.clear();
}
