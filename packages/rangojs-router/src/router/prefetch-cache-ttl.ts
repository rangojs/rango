/**
 * Resolve the prefetch cache TTL once, at router init, into the three derived
 * values the rest of the router consumes: seconds (for the Cache-Control
 * max-age), milliseconds (for the client-side in-memory cache), and the
 * Cache-Control header string (or false when caching is disabled).
 *
 * `false` disables prefetch caching (seconds 0). A non-finite input
 * (NaN/Infinity, e.g. from an env-derived number that failed to parse) is
 * treated as the default rather than producing a malformed
 * `Cache-Control: max-age=NaN` header; CDNs/browsers ignore such a directive,
 * which would silently disable caching on EVERY prefetch response. Negative
 * finite values clamp to 0 (disabled). Mirrors the Number.isFinite guard used
 * in defer.ts and cf-cache-store.ts.
 */
export interface ResolvedPrefetchCacheTTL {
  /** TTL in seconds for the Cache-Control max-age directive. */
  seconds: number;
  /** TTL in milliseconds for the client-side in-memory prefetch cache. */
  ms: number;
  /** Cache-Control header value, or false when caching is disabled. */
  cacheControl: string | false;
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
    // Non-finite (NaN/Infinity): fall back to the default rather than emit a
    // malformed max-age=NaN/Infinity that CDNs and browsers reject.
    seconds = DEFAULT_PREFETCH_CACHE_TTL_SECONDS;
  }

  return {
    seconds,
    ms: seconds * 1000,
    cacheControl: seconds === 0 ? false : `private, max-age=${seconds}`,
  };
}
