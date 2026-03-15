/**
 * Prefetch Cache
 *
 * In-memory cache storing prefetch Response objects for instant cache hits
 * on subsequent navigation. Source-independent: cache key is the target URL
 * only (not source page), because prefetch responses include all matched
 * segments regardless of where the user navigates from.
 *
 * Replaces the previous browser HTTP cache approach which was unreliable
 * due to Vary header complexity and response draining race conditions.
 */

import { cancelAllPrefetches } from "./queue.js";
import { invalidateRangoState } from "../rango-state.js";

const PREFETCH_CACHE_TTL = 30_000; // 30 seconds
const MAX_PREFETCH_CACHE_SIZE = 50;

interface PrefetchCacheEntry {
  response: Response;
  timestamp: number;
}

const cache = new Map<string, PrefetchCacheEntry>();
const inflight = new Set<string>();

// Generation counter incremented on each clearPrefetchCache(). Fetches that
// started before a clear carry a stale generation and must not store their
// response (the data may be stale due to a server action invalidation).
let generation = 0;

/**
 * Build a source-independent cache key from a URL.
 * Uses pathname + search only (no origin, no hash, no RSC internal params).
 */
export function buildCacheKey(url: string | URL): string {
  const parsed = typeof url === "string" ? new URL(url, "http://x") : url;
  return parsed.pathname + parsed.search;
}

/**
 * Check if a prefetch is already cached, in-flight, or queued for the given key.
 */
export function hasPrefetch(key: string): boolean {
  if (inflight.has(key)) return true;
  const entry = cache.get(key);
  if (!entry) return false;
  if (Date.now() - entry.timestamp > PREFETCH_CACHE_TTL) {
    cache.delete(key);
    return false;
  }
  return true;
}

/**
 * Consume a cached prefetch response. Returns null if not found or expired.
 * One-time consumption: the entry is deleted after retrieval.
 */
export function consumePrefetch(key: string): Response | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > PREFETCH_CACHE_TTL) {
    cache.delete(key);
    return null;
  }
  cache.delete(key);
  return entry.response;
}

/**
 * Store a prefetch response in the in-memory cache.
 * The response body must be fully buffered (e.g. via arrayBuffer()) before
 * storing, so the cached Response is self-contained and network-independent.
 *
 * Skips storage if the generation has changed since the fetch started
 * (a server action invalidated the cache mid-flight).
 */
export function storePrefetch(
  key: string,
  response: Response,
  fetchGeneration: number,
): void {
  if (fetchGeneration !== generation) return;

  // Evict expired entries
  const now = Date.now();
  for (const [k, entry] of cache) {
    if (now - entry.timestamp > PREFETCH_CACHE_TTL) {
      cache.delete(k);
    }
  }

  // FIFO eviction if at capacity
  if (cache.size >= MAX_PREFETCH_CACHE_SIZE) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }

  cache.set(key, { response, timestamp: now });
}

/**
 * Capture the current generation. The returned value is passed to
 * storePrefetch so it can detect stale completions.
 */
export function currentGeneration(): number {
  return generation;
}

export function markPrefetchInflight(key: string): void {
  inflight.add(key);
}

export function clearPrefetchInflight(key: string): void {
  inflight.delete(key);
}

/**
 * Invalidate all prefetch state. Called when server actions mutate data.
 * Clears the in-memory cache, cancels in-flight prefetches, and rotates
 * the Rango state key so CDN-cached responses are also invalidated.
 */
export function clearPrefetchCache(): void {
  generation++;
  inflight.clear();
  cache.clear();
  cancelAllPrefetches();
  invalidateRangoState();
}
