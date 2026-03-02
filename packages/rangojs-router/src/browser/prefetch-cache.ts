/**
 * Prefetch Tracking
 *
 * Tracks in-flight and completed prefetches for deduplication.
 * The actual response caching is handled by the browser's HTTP cache
 * via Vary: X-Rango-State.
 */

import { cancelAllPrefetches } from "./prefetch-queue.js";
import { invalidateRangoState } from "./rango-state.js";

const inflight = new Set<string>();
const prefetched = new Set<string>();

/**
 * Check if a prefetch is already in-flight or completed for the given key.
 */
export function hasPrefetch(key: string): boolean {
  return prefetched.has(key) || inflight.has(key);
}

/**
 * Mark a key as successfully prefetched (response is in browser HTTP cache).
 */
export function markPrefetched(key: string): void {
  prefetched.add(key);
}

export function markPrefetchInflight(key: string): void {
  inflight.add(key);
}

export function clearPrefetchInflight(key: string): void {
  inflight.delete(key);
}

/**
 * Invalidate prefetch state. Called when server actions mutate data.
 * Updates the localStorage state key so next fetch has a different
 * X-Rango-State value, causing Vary mismatch in browser HTTP cache.
 * Also cancels any in-flight or queued speculative prefetches.
 */
export function clearPrefetchCache(): void {
  inflight.clear();
  prefetched.clear();
  cancelAllPrefetches();
  invalidateRangoState();
}
