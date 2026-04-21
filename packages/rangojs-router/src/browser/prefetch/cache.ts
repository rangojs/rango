/**
 * Prefetch Cache
 *
 * In-memory cache storing prefetched Response objects for instant cache hits
 * on subsequent navigation. Two key scopes are in play:
 * - Wildcard (default): built by `buildPrefetchKey(rangoState, target)` —
 *   shape `rangoState\0/target?...`. Shared across all source pages and
 *   invalidated automatically when Rango state bumps (deploy or
 *   server-action invalidation).
 * - Source-scoped: built by `buildSourceKey(rangoState, sourceHref, target)`
 *   — shape `rangoState\0sourceHref\0/target?...`. Embeds the Rango state
 *   (so rotation invalidates source-scoped entries too) plus the source
 *   href (so each originating page gets its own slot). Populated when the
 *   server tags a response with `X-RSC-Prefetch-Scope: source` (intercept
 *   modals etc.), OR when a Link opts in with `prefetchKey=":source"` — in
 *   both cases so source-sensitive responses cannot bleed into navigations
 *   from other pages.
 *
 * Also tracks in-flight prefetch promises. Each promise resolves to the
 * navigation branch of a tee'd Response, allowing navigation to adopt a
 * still-downloading prefetch without reparsing or buffering the body. A
 * single promise can be registered under multiple alias keys (see
 * `setInflightPromiseWithAliases`) so same-source navigations adopt via
 * their source key while cross-source ones fall through to the wildcard
 * alias — with consume/clear atomically removing every alias.
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

/**
 * Alias map for in-flight promises registered under multiple keys (see
 * dual inflight in prefetch/fetch.ts). Records each key's sibling set so
 * that consuming or clearing any one key atomically removes every alias —
 * guaranteeing a single consumer for the shared Response stream.
 */
const inflightAliases = new Map<string, string[]>();

// Generation counter incremented on each clearPrefetchCache(). Fetches that
// started before a clear carry a stale generation and must not store their
// response (the data may be stale due to a server action invalidation).
let generation = 0;

/**
 * Build a cache key by combining a scope prefix with the target URL.
 *
 * Low-level primitive — callers that want a specific scope should use
 * one of:
 * - Wildcard (source-agnostic): prefix is the Rango state value from
 *   `getRangoState()`. Shared across all source pages. Invalidated
 *   automatically when Rango state bumps (deploy or server-action).
 *   Key shape: `rangoState\0/target?...`.
 * - Source-scoped: use `buildSourceKey()`. Key shape:
 *   `rangoState\0sourceHref\0/target?...` — embeds the Rango state so
 *   rotation invalidates source-scoped entries alongside wildcard ones,
 *   plus the source page href so the key is unique per originating page.
 *   Populated either when the server tags a response with
 *   `X-RSC-Prefetch-Scope: source` (intercept modals, etc.) or when a
 *   Link opts in via `prefetchKey=":source"`.
 *
 * The `_rsc_segments` query param that travels in the target URL means
 * clients with different mounted segment trees naturally get different
 * keys — so segment-level diffs remain consistent across both scopes.
 */
export function buildPrefetchKey(prefix: string, targetUrl: URL): string {
  return prefix + "\0" + targetUrl.pathname + targetUrl.search;
}

/**
 * Build a source-scoped cache key. Key shape:
 * `rangoState\0sourceHref\0/target?...`.
 *
 * - `rangoState` is included so state rotation invalidates source-scoped
 *   entries alongside wildcard ones.
 * - `sourceHref` makes the key unique per originating page.
 */
export function buildSourceKey(
  rangoState: string,
  sourceHref: string,
  targetUrl: URL,
): string {
  return buildPrefetchKey(rangoState + "\0" + sourceHref, targetUrl);
}

/**
 * Walk an inflight key plus any sibling aliases registered via
 * `setInflightPromiseWithAliases`, invoking `fn` for each.
 */
function forEachAlias(key: string, fn: (k: string) => void): void {
  const aliases = inflightAliases.get(key);
  if (aliases) {
    for (const k of aliases) fn(k);
  } else {
    fn(key);
  }
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
 * One-time consumption: the promise entry is removed (along with any
 * sibling aliases registered via `setInflightPromiseWithAliases`) so a
 * second call on any alias returns null — only one caller can adopt the
 * shared Response stream. The `inflight` set entry is intentionally
 * kept so that `hasPrefetch()` continues to return true while the
 * underlying fetch is still downloading — this prevents
 * `prefetchDirect()` or other callers from starting a duplicate request
 * during the handoff window. The inflight flag is cleaned up naturally
 * by `clearPrefetchInflight()` in the fetch's `.finally()`.
 */
export function consumeInflightPrefetch(
  key: string,
): Promise<Response | null> | null {
  const promise = inflightPromises.get(key);
  if (!promise) return null;
  // Remove the promise under every alias so a second consumer cannot
  // adopt the same stream and race on the body. `inflightAliases` is
  // intentionally preserved — `clearPrefetchInflight()` in the fetch's
  // `.finally()` still needs it to clear every inflight flag; deleting
  // here would strand the sibling's flag forever.
  forEachAlias(key, (k) => inflightPromises.delete(k));
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

/**
 * Store the same in-flight Promise under multiple keys, recording them
 * as sibling aliases. Consuming or clearing any one alias atomically
 * removes every entry, guaranteeing the shared Response stream has a
 * single consumer even when navigation looks up either key.
 */
export function setInflightPromiseWithAliases(
  keys: string[],
  promise: Promise<Response | null>,
): void {
  for (const k of keys) {
    inflightPromises.set(k, promise);
    inflightAliases.set(k, keys);
  }
}

export function clearPrefetchInflight(key: string): void {
  forEachAlias(key, (k) => {
    inflight.delete(k);
    inflightPromises.delete(k);
    inflightAliases.delete(k);
  });
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
  inflightAliases.clear();
  cache.clear();
  abortAllPrefetches();
  invalidateRangoState();
}

/**
 * Drop all in-memory prefetch state for this tab without rotating rango-state.
 *
 * Use for local-only invalidations (e.g. app switch in this tab) where
 * other tabs should NOT observe a state rotation. Unlike clearPrefetchCache,
 * does not call invalidateRangoState, so the shared X-Rango-State token
 * stays intact and siblings in the old app keep their prefetches.
 */
export function clearPrefetchCacheLocal(): void {
  generation++;
  inflight.clear();
  inflightPromises.clear();
  cache.clear();
  abortAllPrefetches();
}
