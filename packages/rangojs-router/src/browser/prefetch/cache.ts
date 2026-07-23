/**
 * Prefetch Cache
 *
 * In-memory cache storing eagerly-decoded prefetch payloads for instant,
 * already-warm cache hits on subsequent navigation. A prefetch fetches the
 * RSC partial AND decodes it (createFromFetch) up front — decoding the Flight
 * stream resolves the route's client references, so the route's JS chunks are
 * imported during prefetch rather than on click. The decoded payload is reused
 * verbatim by navigation, so a prefetched click loads no new code. Two key
 * scopes are in play:
 * - Wildcard (default): built by `buildPrefetchKey(rangoState, target)` —
 *   shape `rangoState\0/target?...`. Shared across all source pages and
 *   source segment trees; `_rsc_segments` is omitted from this key. Invalidated
 *   automatically when Rango state bumps (deploy or server-action invalidation).
 * - Source-scoped: built by `buildSourceKey(rangoState, sourceHref, target)`
 *   — shape `rangoState\0sourceHref\0/target?...`. Embeds the Rango state
 *   (so rotation invalidates source-scoped entries too), the source href, and
 *   the exact source segment tree. Populated when the
 *   server tags a response with `X-RSC-Prefetch-Scope: source` (intercept
 *   modals etc.), OR when a Link opts in with `prefetchKey=":source"` — in
 *   both cases so source-sensitive responses cannot bleed into navigations
 *   from other pages.
 *
 * Also tracks in-flight prefetch promises. Each promise resolves to the
 * decoded prefetch entry (or null), letting navigation adopt a
 * still-downloading prefetch without issuing a duplicate request. A
 * single promise can be registered under multiple alias keys (see
 * `setInflightPromiseWithAliases`) so same-source navigations adopt via
 * their source key while cross-source ones fall through to the wildcard
 * alias — with consume/clear atomically removing every alias.
 *
 * Replaces the previous browser HTTP cache approach which was unreliable
 * due to response draining race conditions and browser inconsistencies.
 *
 * State here lives in module-level singletons (cache, inflight, generation,
 * cacheTTL, etc.) rather than a per-instance factory. This is correct because
 * exactly one router is live per document — an SPA navigation crossing a
 * host-router boundary forces a full document reload — so the singletons are
 * effectively per-document. Unit tests reset them via clearPrefetchCache().
 */

import { abortAllPrefetches } from "./loader.js";
import { notifyPrefetchCacheInvalidated } from "./invalidation.js";
import { invalidateRangoState } from "../rango-state.js";
import type { RscPayload } from "../types.js";

/**
 * A prefetch that has been fetched AND eagerly decoded. Storing the decoded
 * payload (not the raw Response) is what makes a prefetched navigation "warm":
 * decoding the Flight stream during prefetch pulls the route's client chunks,
 * so the click reuses ready elements and loads no new JS.
 */
export interface DecodedPrefetch {
  /** The eagerly-decoded RSC payload. Reused verbatim by navigation. */
  payload: Promise<RscPayload>;
  /**
   * Resolves when the underlying RSC stream finishes draining. Navigation
   * forwards this as its streamComplete so scroll/revalidation gating is
   * unchanged from the fresh-fetch path.
   */
  streamComplete: Promise<void>;
  /**
   * Prefetch scope as tagged by the server via `X-RSC-Prefetch-Scope`.
   * `"source"` means the response is source-page-sensitive and must not be
   * reused by a navigation from a different page — navigation enforces this
   * when it adopted an inflight entry through the wildcard key.
   */
  scope: "source" | "wildcard";
  /**
   * Synchronously-readable flag, flipped to true when `streamComplete` resolves
   * (the entire RSC stream has drained). Navigation reads this at click time to
   * tell a FULLY warmed prefetch (payload commits without suspending → safe to
   * commit in a startTransition, no fallback flash) from a partially-warmed one
   * (still streaming → stream its fallbacks like a cold load). Starts false.
   *
   * On a respawned entry (see `respawn`) this starts true: the buffered bytes
   * are a complete stream by construction.
   */
  complete: boolean;
  /**
   * Re-create this entry from its buffered raw Flight bytes. Attached (by
   * `executePrefetchFetch`) only after the stream ended cleanly AND the eager
   * decode succeeded — a truncated or failed prefetch must stay one-shot.
   *
   * Why bytes and not the decoded payload: the revived payload is a live graph
   * with one-shot stream edges (the handle stream is an async generator drained
   * during commit; userland payloads may embed serialized ReadableStreams).
   * Re-decoding from the wire bytes manufactures fresh instances of every
   * stream, which no amount of cloning the revived graph can do. Each call tees
   * the reserve branch, so the replacement entry carries its own `respawn` —
   * one prefetch serves unlimited adoptions within TTL/state validity.
   */
  respawn?: () => DecodedPrefetch;
  /**
   * Release the buffered reserve bytes. Called when the entry is evicted
   * without being consumed (expiry, FIFO, sweep, cache clear) so the tee
   * buffer is dropped promptly instead of waiting for GC.
   */
  dispose?: () => void;
}

let cacheTTL = 300_000;
let fragmentPassthroughEnabled = true;

// Max stored entries before FIFO eviction. Mirrors DEFAULT_PREFETCH_CACHE_SIZE
// (router/prefetch-limits.ts); kept as a local literal so the client bundle
// doesn't pull in router-layer code, matching the cacheTTL default above.
// Overridden at startup by initPrefetchCache from server metadata.
let maxPrefetchCacheSize = 100;

/**
 * Initialize the prefetch cache with the configured TTL and max size.
 * Called once at app startup with the values from server metadata. Each
 * argument is applied only when provided, so a caller can set just the TTL.
 * A TTL of 0 disables the in-memory cache and all prefetching. A size below 1
 * is ignored (the default is kept) — disabling prefetch is the TTL's job.
 */
export function initPrefetchCache(ttlMs?: number, maxSize?: number): void {
  if (ttlMs !== undefined) cacheTTL = ttlMs;
  if (maxSize !== undefined && Number.isFinite(maxSize) && maxSize >= 1) {
    maxPrefetchCacheSize = Math.floor(maxSize);
  }
}

/**
 * Check if the prefetch cache is disabled (TTL <= 0).
 * When disabled, no prefetch requests should be issued.
 */
export function isPrefetchCacheDisabled(): boolean {
  return cacheTTL <= 0;
}

interface PrefetchCacheEntry {
  entry: DecodedPrefetch;
  timestamp: number;
}

const cache = new Map<string, PrefetchCacheEntry>();
const inflight = new Set<string>();

// Watermark: the smallest entry timestamp currently in `cache`, i.e. a lower
// bound on when the oldest entry expires (timestamp + cacheTTL). storePrefetch's
// eager expiry sweep is skipped while `now - earliestTimestamp <= cacheTTL` — the
// oldest entry cannot be expired yet, so nothing would be evicted. Deletions
// (consume/has/remove) may leave it stale-LOW, which only forces a harmless extra
// sweep that recomputes it exactly; it is never stale-high, so a skipped sweep
// can never retain an expired entry. consume/has still TTL-check lazily, so a
// skipped sweep never serves a stale entry. Infinity when the cache is empty.
let earliestTimestamp = Infinity;

const inflightPromises = new Map<string, Promise<DecodedPrefetch | null>>();

const inflightAliases = new Map<string, string[]>();

const adoptedKeys = new Set<string>();

let generation = 0;

/**
 * Build a cache key by combining a scope prefix with the target URL.
 *
 * Low-level primitive — callers that want a specific scope should use
 * one of:
 * - Wildcard (source-agnostic): prefix is the Rango state value from
 *   `getRangoState()`. Shared across all source pages. Invalidated
 *   automatically when Rango state bumps (deploy or server-action).
 *   `_rsc_segments` is omitted so sibling payloads prefetched from one page
 *   remain reusable after another prefetched navigation commits. Key shape:
 *   `rangoState\0/target?...`.
 * - Source-scoped: use `buildSourceKey()`. Key shape:
 *   `rangoState\0sourceHref\0/target?...` — embeds the Rango state so
 *   rotation invalidates source-scoped entries alongside wildcard ones,
 *   plus the source page href so the key is unique per originating page.
 *   Populated either when the server tags a response with
 *   `X-RSC-Prefetch-Scope: source` (intercept modals, etc.) or when a
 *   Link opts in via `prefetchKey=":source"`.
 *
 * Source-scoped keys retain `_rsc_segments` because their exact source tree is
 * part of the opt-in contract. Wildcard responses are source-agnostic by
 * contract; callers use source scope when a custom revalidation decision makes
 * the response depend on the current URL or segment tree.
 */
export function buildPrefetchKey(prefix: string, targetUrl: URL): string {
  const normalizedTarget = new URL(targetUrl);
  normalizedTarget.searchParams.delete("_rsc_segments");
  return prefix + "\0" + normalizedTarget.pathname + normalizedTarget.search;
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
  return (
    rangoState +
    "\0" +
    sourceHref +
    "\0" +
    targetUrl.pathname +
    targetUrl.search
  );
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
    entry.entry.dispose?.();
    cache.delete(key);
    return false;
  }
  return true;
}

/**
 * Consume a cached, eagerly-decoded prefetch. Returns null if not found or
 * expired. Returns null when caching is disabled (TTL <= 0).
 *
 * A decoded payload is single-render (its handle stream is drained during the
 * commit), so the returned entry is never served twice. When the entry carries
 * `respawn` (clean-EOF prefetch with buffered bytes), the slot is re-armed in
 * place with a fresh decode of those bytes — the ORIGINAL timestamp is kept so
 * TTL bounds the age of the data, not of the latest adoption. Without
 * `respawn` the entry is deleted (legacy one-shot behavior).
 *
 * Does NOT check in-flight prefetches — use consumeInflightPrefetch()
 * for that (returns a Promise instead of a resolved entry).
 */
export function consumePrefetch(key: string): DecodedPrefetch | null {
  if (cacheTTL <= 0) return null;
  const cached = cache.get(key);
  if (!cached) return null;
  if (Date.now() - cached.timestamp > cacheTTL) {
    cached.entry.dispose?.();
    cache.delete(key);
    return null;
  }
  const entry = cached.entry;
  if (entry.respawn) {
    cached.entry = entry.respawn();
  } else {
    cache.delete(key);
  }
  return entry;
}

/**
 * Consume an in-flight prefetch promise. Returns null if no prefetch is
 * in-flight for this key. The returned Promise resolves to the decoded
 * prefetch entry (or null if the fetch failed/was aborted, or carried a
 * control header the navigation must re-fetch to honor).
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
): Promise<DecodedPrefetch | null> | null {
  const promise = inflightPromises.get(key);
  if (!promise) return null;
  // Remove the promise under every alias so a second consumer cannot
  // adopt the same stream and race on the body, and mark every alias as
  // adopted so the pending `storePrefetch` (which resolves later, after this
  // adoption) does not leave the now-owned, single-use entry in the cache map.
  // `inflightAliases` is intentionally preserved — `clearPrefetchInflight()` in
  // the fetch's `.finally()` still needs it to clear every inflight flag and
  // adopted marker; deleting here would strand the sibling's flag forever.
  forEachAlias(key, (k) => {
    inflightPromises.delete(k);
    adoptedKeys.add(k);
  });
  return promise;
}

/**
 * Store an eagerly-decoded prefetch in the in-memory cache.
 *
 * Skips storage if the generation has changed since the fetch started
 * (a server action invalidated the cache mid-flight).
 */
export function storePrefetch(
  key: string,
  entry: DecodedPrefetch,
  fetchGeneration: number,
): void {
  if (cacheTTL <= 0) return;
  if (fetchGeneration !== generation) return;

  // If a navigation already adopted this prefetch's in-flight promise, it owns
  // the single-use entry (and has drained its handle generator). Do NOT also
  // publish it to the cache map, or a later navigation would be served the
  // exhausted entry and lose that route's handles. Clear the marker (under all
  // aliases) now that the decision is made.
  if (adoptedKeys.has(key)) {
    forEachAlias(key, (k) => adoptedKeys.delete(k));
    return;
  }

  // Evict expired entries — but only when the watermark says the oldest entry
  // could have expired, so a burst of stores no longer walks the whole map each
  // time. The sweep recomputes the exact watermark from the survivors.
  const now = Date.now();
  if (now - earliestTimestamp > cacheTTL) {
    let min = Infinity;
    for (const [k, cached] of cache) {
      if (now - cached.timestamp > cacheTTL) {
        cached.entry.dispose?.();
        cache.delete(k);
      } else if (cached.timestamp < min) {
        min = cached.timestamp;
      }
    }
    earliestTimestamp = min;
  }

  // FIFO eviction if at capacity
  if (cache.size >= maxPrefetchCacheSize) {
    const oldest = cache.keys().next().value;
    if (oldest) {
      cache.get(oldest)?.entry.dispose?.();
      cache.delete(oldest);
    }
  }

  cache.set(key, { entry, timestamp: now });
  // The new entry is the newest, so it only moves the watermark when the cache
  // was empty (Infinity); otherwise the older watermark stands.
  if (now < earliestTimestamp) earliestTimestamp = now;
}

/**
 * Remove a single stored prefetch entry. Used to evict an entry whose body
 * stream stalled after headers arrived (its payload / streamComplete never
 * settle), so future prefetches and navigation refetch instead of dedupe-ing
 * against — and awaiting — a stuck entry.
 *
 * Identity-guarded: only evicts when the entry CURRENTLY stored under `key` is
 * the exact `entry` we published. A generation check alone is insufficient —
 * after this entry is consumed (consumePrefetch) and a fresh prefetch
 * republishes under the SAME key in the SAME generation, a gen-only guard would
 * delete that valid newer entry. Reference identity drops only our own stalled
 * entry.
 */
export function removePrefetch(key: string, entry: DecodedPrefetch): void {
  if (cache.get(key)?.entry === entry) {
    entry.dispose?.();
    cache.delete(key);
  }
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

export function setInflightPromise(
  key: string,
  promise: Promise<DecodedPrefetch | null>,
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
  promise: Promise<DecodedPrefetch | null>,
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
    adoptedKeys.delete(k);
  });
}

/** Whether this document may request stored segment fragment envelopes. */
export function isFragmentPassthroughEnabled(): boolean {
  return fragmentPassthroughEnabled;
}

/**
 * Disable fragment passthrough for the rest of this document after one stored
 * fragment fails to decode. The recovery replaces shared cache entries, while
 * this guard prevents the current tab's HTTP cache from serving its already-
 * cached corrupt variant again.
 */
export function disableFragmentPassthrough(): void {
  if (!fragmentPassthroughEnabled) return;
  fragmentPassthroughEnabled = false;
  clearPrefetchCache(false);
}

export function clearPrefetchCache(rotateRangoState = true): void {
  generation++;
  inflight.clear();
  inflightPromises.clear();
  inflightAliases.clear();
  adoptedKeys.clear();
  for (const cached of cache.values()) cached.entry.dispose?.();
  cache.clear();
  earliestTimestamp = Infinity;
  abortAllPrefetches();
  if (rotateRangoState) invalidateRangoState();
  notifyPrefetchCacheInvalidated();
}
