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

/**
 * Host-namespaced cache key base: `${host}${pathname}[:params][?search]`.
 *
 * The ONE composition of the host-namespacing rule, shared by the segment tier
 * (cache-scope.ts) and the document tier (document-cache.ts) so the rule cannot
 * drift between them. Host prefixing matters because VercelCacheStore /
 * MemorySegmentCacheStore key by the raw string (only CFCacheStore adds host
 * internally) -- on a single function serving multiple domains an
 * un-namespaced key bleeds tenant A's cached response to tenant B.
 *
 * Output is BYTE-STABLE by contract: changing the composition silently
 * invalidates every persisted cache entry on upgrade. Callers append their own
 * tier-specific suffixes (`:rsc`/`:html`, segment hash) after this base.
 */
export function cacheKeyBase(
  host: string,
  pathname: string,
  searchParams?: URLSearchParams,
  params?: Record<string, string>,
): string {
  const paramStr = sortedRouteParams(params);
  const searchStr = searchParams ? sortedSearchString(searchParams) : "";

  let key = `${host}${pathname}`;
  if (paramStr) key += `:${paramStr}`;
  if (searchStr) key += `?${searchStr}`;
  return key;
}
