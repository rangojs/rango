/**
 * Prefetch Cache
 *
 * Stores prefetched RSC responses for consumption by fetchPartial.
 * Responses are stored as raw Response objects and consumed one-shot
 * (deleted on use) to prevent serving stale data.
 */

import { LRUCache } from "./lru-cache.js";
import { cancelAllPrefetches } from "./prefetch-queue.js";

const PREFETCH_CACHE_SIZE = 10;

const cache = new LRUCache<string, Response>(PREFETCH_CACHE_SIZE);
const inflight = new Set<string>();
// Browser-mode dedup: tracks URLs that already have a <link rel="prefetch">
const browserPrefetched = new Set<string>();

/**
 * Generate a prefetch cache key from a URL.
 * Uses pathname only — segment IDs at prefetch time may differ from
 * navigation time, and the server handles any segment set.
 */
export function prefetchCacheKey(url: string): string {
  try {
    const parsed = new URL(url, window.location.origin);
    return parsed.pathname;
  } catch {
    return url;
  }
}

/**
 * Store a prefetched response. The response must be cloned before calling this.
 */
export function storePrefetchResponse(key: string, response: Response): void {
  cache.set(key, response);
}

/**
 * Consume a prefetched response (one-shot: removes from cache).
 * Returns undefined if no cached response exists.
 */
export function consumePrefetchResponse(key: string): Response | undefined {
  const response = cache.get(key);
  if (response) {
    cache.delete(key);
  }
  return response;
}

/**
 * Check if a prefetch is already in-flight or cached for the given key.
 */
export function hasPrefetch(key: string): boolean {
  return cache.has(key) || inflight.has(key);
}

/**
 * Check if a URL was already prefetched in browser mode.
 */
export function hasBrowserPrefetch(url: string): boolean {
  return browserPrefetched.has(url);
}

export function markBrowserPrefetch(url: string): void {
  browserPrefetched.add(url);
}

export function markPrefetchInflight(key: string): void {
  inflight.add(key);
}

export function clearPrefetchInflight(key: string): void {
  inflight.delete(key);
}

/**
 * Clear all cached prefetch responses and in-flight tracking.
 * Called when server actions invalidate data.
 */
export function clearPrefetchCache(): void {
  cache.clear();
  inflight.clear();
  browserPrefetched.clear();
  cancelAllPrefetches();
}
