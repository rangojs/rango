/**
 * Shared Cache Key Utilities
 *
 * Deterministic normalization of search params and route params
 * for cache key generation. Used by cache-runtime, cache-scope,
 * document-cache, and loader-cache.
 */

import { encodeKV } from "../encode-kv.js";

/**
 * Reserved URL query params that the router owns and must never key the cache
 * on. `_rsc*` is the router's internal navigation/action/loader prefix (matched
 * by prefix). `__no_cache` is the single `__`-prefixed param the router reads
 * (handler.ts / testing dispatch.ts use it to bypass the store); it and the
 * other router-internal `__`-prefixed request params are matched by an EXACT
 * allowlist, not a blanket `__` prefix. A blanket `__` filter would silently
 * collapse consumer params like `__variant=a` vs `__variant=b` onto one cache
 * slot; an allowlist keeps the router's own params out of the key while leaving
 * consumer `__` params intact.
 */
const RESERVED_SEARCH_PARAMS = new Set([
  "__no_cache",
  "__rsc",
  "__html",
  "__debug_manifest",
  "__prerender_collect",
]);

function isReservedSearchParam(key: string): boolean {
  return key.startsWith("_rsc") || RESERVED_SEARCH_PARAMS.has(key);
}

/**
 * Build a sorted, deterministic query string from URLSearchParams,
 * excluding the router's reserved params (see isReservedSearchParam).
 *
 * Returns empty string when no user-facing params exist.
 */
export function sortedSearchString(searchParams: URLSearchParams): string {
  const pairs: [string, string][] = [];
  for (const [k, v] of searchParams) {
    if (!isReservedSearchParam(k)) {
      pairs.push([k, v]);
    }
  }
  return encodeKV(pairs, { sort: true });
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
  return encodeKV(Object.entries(params), { sort: true });
}
