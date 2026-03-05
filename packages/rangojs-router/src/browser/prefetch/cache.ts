/**
 * Prefetch Tracking
 *
 * Tracks in-flight and completed prefetches for deduplication.
 * The actual response caching is handled by the browser's HTTP cache
 * via Vary: X-Rango-State.
 */

import { cancelAllPrefetches } from "./queue.js";
import { invalidateRangoState } from "../rango-state.js";

const inflight = new Set<string>();
const prefetched = new Set<string>();

// Generation counter incremented on each clearPrefetchCache(). Fetches that
// started before a clear carry a stale generation and must not re-add their
// key to the prefetched set (the browser HTTP cache entry is already invalid
// due to Rango-State rotation).
let generation = 0;

/**
 * Check if a prefetch is already in-flight or completed for the given key.
 */
export function hasPrefetch(key: string): boolean {
  return prefetched.has(key) || inflight.has(key);
}

/**
 * Capture the current generation. The returned value is passed to
 * markPrefetched so it can detect stale completions.
 */
export function currentGeneration(): number {
  return generation;
}

/**
 * Mark a key as successfully prefetched (response is in browser HTTP cache).
 * Skips if the generation has changed since the fetch started (cache was
 * invalidated mid-flight, so the response uses a stale X-Rango-State).
 */
export function markPrefetched(key: string, fetchGeneration: number): void {
  if (fetchGeneration === generation) {
    prefetched.add(key);
  }
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
  generation++;
  inflight.clear();
  prefetched.clear();
  cancelAllPrefetches();
  invalidateRangoState();
}
