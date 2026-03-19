/**
 * Prefetch Cache
 *
 * In-memory cache storing prefetch Response objects for instant cache hits
 * on subsequent navigation. Cache key is source-dependent (includes the
 * current page URL) because the server's diff-based response depends on
 * where the user navigates from.
 *
 * Also tracks in-flight prefetch promises so navigation can reuse a
 * prefetch that is still downloading rather than starting a duplicate
 * request. See consumeInflightPrefetch().
 *
 * Replaces the previous browser HTTP cache approach which was unreliable
 * due to response draining race conditions and browser inconsistencies.
 */

import { abortAllPrefetches } from "./queue.js";
import { invalidateRangoState } from "../rango-state.js";

// Default TTL: 5 minutes. Overridden by initPrefetchCache() with
// the server-configured prefetchCacheTTL from router options.
// 0 disables the in-memory cache entirely.
let cacheTTL = 300_000;

/**
 * Initialize the prefetch cache with the configured TTL.
 * Called once at app startup with the value from server metadata.
 * A TTL of 0 disables the in-memory cache and all prefetching.
 */
export function initPrefetchCache(ttlMs: number): void {
  cacheTTL = ttlMs;
}

/**
 * Check if the prefetch cache is disabled (TTL <= 0).
 * When disabled, no prefetch requests should be issued.
 */
export function isPrefetchCacheDisabled(): boolean {
  return cacheTTL <= 0;
}
const MAX_PREFETCH_CACHE_SIZE = 50;

interface PrefetchCacheEntry {
  response: Response;
  timestamp: number;
}

const cache = new Map<string, PrefetchCacheEntry>();
const inflight = new Set<string>();

/**
 * In-flight promise map. When a prefetch fetch is in progress, its
 * Promise<Response | null> is stored here so navigation can await
 * it instead of starting a duplicate request.
 */
const inflightPromises = new Map<string, Promise<Response | null>>();

// Generation counter incremented on each clearPrefetchCache(). Fetches that
// started before a clear carry a stale generation and must not store their
// response (the data may be stale due to a server action invalidation).
let generation = 0;

/**
 * Build a source-dependent cache key.
 * Includes the source page href so the same target prefetched from
 * different pages gets separate entries — the server response varies
 * based on the source page context (diff-based rendering).
 */
export function buildPrefetchKey(sourceHref: string, targetUrl: URL): string {
  return sourceHref + "\0" + targetUrl.pathname + targetUrl.search;
}

/**
 * Check if a prefetch is already cached, in-flight, or queued for the given key.
 */
export function hasPrefetch(key: string): boolean {
  if (inflight.has(key)) return true;
  if (cacheTTL <= 0) return false;
  const entry = cache.get(key);
  if (!entry) return false;
  if (Date.now() - entry.timestamp > cacheTTL) {
    cache.delete(key);
    return false;
  }
  return true;
}

/**
 * Consume a cached prefetch response. Returns null if not found or expired.
 * One-time consumption: the entry is deleted after retrieval.
 * Returns null when caching is disabled (TTL <= 0).
 *
 * Does NOT check in-flight prefetches — use consumeInflightPrefetch()
 * for that (returns a Promise instead of a Response).
 */
export function consumePrefetch(key: string): Response | null {
  if (cacheTTL <= 0) return null;
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > cacheTTL) {
    cache.delete(key);
    return null;
  }
  cache.delete(key);
  return entry.response;
}

/**
 * Consume an in-flight prefetch promise. Returns null if no prefetch is
 * in-flight for this key. The returned Promise resolves to the buffered
 * Response (or null if the fetch failed/was aborted).
 *
 * One-time consumption: the promise entry is removed so a second call
 * returns null. The `inflight` set entry is intentionally kept so that
 * hasPrefetch() continues to return true while the underlying fetch is
 * still downloading — this prevents prefetchDirect() or other callers
 * from starting a duplicate request during the handoff window. The
 * inflight flag is cleaned up naturally by clearPrefetchInflight() in
 * the fetch's .finally().
 */
export function consumeInflightPrefetch(
  key: string,
): Promise<Response | null> | null {
  const promise = inflightPromises.get(key);
  if (!promise) return null;
  // Remove the promise (one-time consumption) but keep the inflight flag.
  inflightPromises.delete(key);
  return promise;
}

/**
 * Store a prefetch response in the in-memory cache.
 * The response should be a clone() of the original so the caller can
 * still consume the body. The clone's body streams independently.
 *
 * Skips storage if the generation has changed since the fetch started
 * (a server action invalidated the cache mid-flight).
 */
export function storePrefetch(
  key: string,
  response: Response,
  fetchGeneration: number,
): void {
  if (cacheTTL <= 0) return;
  if (fetchGeneration !== generation) return;

  // Evict expired entries
  const now = Date.now();
  for (const [k, entry] of cache) {
    if (now - entry.timestamp > cacheTTL) {
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

/**
 * Store the in-flight Promise for a prefetch so navigation can reuse it.
 */
export function setInflightPromise(
  key: string,
  promise: Promise<Response | null>,
): void {
  inflightPromises.set(key, promise);
}

export function clearPrefetchInflight(key: string): void {
  inflight.delete(key);
  inflightPromises.delete(key);
}

/**
 * Invalidate all prefetch state. Called when server actions mutate data.
 * Clears the in-memory cache, cancels in-flight prefetches, and rotates
 * the Rango state key so CDN-cached responses are also invalidated.
 *
 * Uses abortAllPrefetches (hard cancel) because in-flight responses
 * may contain stale data after a mutation.
 */
export function clearPrefetchCache(): void {
  generation++;
  inflight.clear();
  inflightPromises.clear();
  cache.clear();
  abortAllPrefetches();
  invalidateRangoState();
}
