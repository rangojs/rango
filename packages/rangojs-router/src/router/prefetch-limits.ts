/**
 * Resolve the client-side prefetch limits — the in-memory prefetch cache size
 * and the speculative-prefetch queue concurrency — once, at router init. Both
 * are positive-integer counts shipped to the browser in payload metadata; the
 * browser entry feeds them to the prefetch cache (`initPrefetchCache`) and the
 * prefetch queue (`setPrefetchConcurrency`) at startup.
 *
 * Policy note: this is a SEPARATE policy from resolvePrefetchCacheTTL
 * (prefetch-cache-ttl.ts). These are counts, not durations, so the disable
 * paths differ: a TTL of `false`/0 intentionally turns prefetching off, but a
 * cache size or concurrency of 0 would silently break prefetching while leaving
 * it nominally enabled — never the intent of passing a number. So any value
 * that is not a finite integer >= 1 (0, negative, fractional below 1, NaN,
 * Infinity, undefined) falls back to the default. Finite values >= 1 are
 * floored. Do not unify this guard with the TTL guard.
 */

export const DEFAULT_PREFETCH_CACHE_SIZE = 100;
export const DEFAULT_PREFETCH_CONCURRENCY = 2;

export function resolvePrefetchCacheSize(raw: number | undefined): number {
  return resolvePositiveCount(raw, DEFAULT_PREFETCH_CACHE_SIZE);
}

export function resolvePrefetchConcurrency(raw: number | undefined): number {
  return resolvePositiveCount(raw, DEFAULT_PREFETCH_CONCURRENCY);
}

function resolvePositiveCount(
  raw: number | undefined,
  fallback: number,
): number {
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 1) {
    return Math.floor(raw);
  }
  return fallback;
}
