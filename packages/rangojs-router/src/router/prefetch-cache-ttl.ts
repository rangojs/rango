/**
 * Resolve the prefetch cache TTL once, at router init, into the values the
 * rest of the router consumes: seconds, and milliseconds for the client-side
 * in-memory prefetch cache (shipped in payload metadata). Prefetch responses
 * carry no Cache-Control: the browser HTTP cache would keep a prefetch whose
 * render failed after its 200 went out (#1170).
 *
 * `false` disables prefetch caching (seconds 0). A non-finite input
 * (NaN/Infinity, e.g. from an env-derived number that failed to parse) is
 * treated as the default rather than disabling the cache. Negative finite
 * values clamp to 0 (disabled).
 *
 * Policy note: this is the prefetch-TTL policy specifically. Other finite-number
 * guards in the codebase deliberately differ — defer.ts treats Infinity as an
 * intentional disable, and profile-registry.ts THROWS on non-finite/negative ttl
 * at config time. They are NOT the same guard, so don't unify them.
 */
export interface ResolvedPrefetchCacheTTL {
  /** TTL in seconds. */
  seconds: number;
  /** TTL in milliseconds for the client-side in-memory prefetch cache. */
  ms: number;
}

const DEFAULT_PREFETCH_CACHE_TTL_SECONDS = 300;

export function resolvePrefetchCacheTTL(
  rawTTL: number | false | undefined,
): ResolvedPrefetchCacheTTL {
  let seconds: number;
  if (rawTTL === false) {
    seconds = 0;
  } else if (rawTTL === undefined) {
    seconds = DEFAULT_PREFETCH_CACHE_TTL_SECONDS;
  } else if (typeof rawTTL === "number" && Number.isFinite(rawTTL)) {
    seconds = Math.max(0, Math.floor(rawTTL));
  } else {
    // Non-finite (NaN/Infinity): fall back to the default.
    seconds = DEFAULT_PREFETCH_CACHE_TTL_SECONDS;
  }

  return { seconds, ms: seconds * 1000 };
}
