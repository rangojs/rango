/**
 * Shared Cache Key Utilities
 *
 * Deterministic normalization of search params and route params
 * for cache key generation. Used by cache-runtime, cache-scope,
 * document-cache, and loader-cache.
 */

/**
 * Build a sorted, deterministic query string from URLSearchParams,
 * excluding internal _rsc* and __* params.
 *
 * Returns empty string when no user-facing params exist.
 */
export function sortedSearchString(searchParams: URLSearchParams): string {
  const pairs: [string, string][] = [];
  for (const [k, v] of searchParams) {
    if (!k.startsWith("_rsc") && !k.startsWith("__")) {
      pairs.push([k, v]);
    }
  }
  if (pairs.length === 0) return "";
  pairs.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return pairs
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}

/**
 * Build a sorted, deterministic string from route params.
 *
 * Returns empty string when params is empty or undefined.
 */
export function sortedRouteParams(
  params: Record<string, string> | undefined,
): string {
  if (!params) return "";
  const entries = Object.entries(params);
  if (entries.length === 0) return "";
  return entries
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}
