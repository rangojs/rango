/**
 * Shared Cache Key Utilities
 *
 * Deterministic normalization of search params and route params
 * for cache key generation, and the composition of nested cache() keys.
 * Used by cache-runtime, cache-scope, document-cache, and loader-cache.
 */

import { encodeKV } from "../encode-kv.js";
import type { SearchParamsFilter } from "./search-params-filter.js";

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
const RESERVED_SEARCH_PARAMS = new Set(["__no_cache", "__rsc", "__html"]);

function isReservedSearchParam(key: string): boolean {
  return key.startsWith("_rsc") || RESERVED_SEARCH_PARAMS.has(key);
}

/**
 * Build a sorted, deterministic query string from URLSearchParams,
 * excluding the router's reserved params (see isReservedSearchParam).
 *
 * `filter` is the compiled `cache.searchParams` config (search-params-filter.ts),
 * applied AFTER the reserved-param exclusion and BEFORE the sort, so reserved
 * params can never be re-included (`include: ["__no_cache"]` is a no-op) and
 * surviving params stay order-insensitive. `undefined` means no filtering --
 * that path must stay byte-identical to the pre-filter format (cacheKeyBase
 * output is byte-stable by contract).
 *
 * Returns empty string when no user-facing params survive.
 */
export function sortedSearchString(
  searchParams: URLSearchParams,
  filter?: SearchParamsFilter,
): string {
  const pairs: [string, string][] = [];
  for (const [k, v] of searchParams) {
    if (!isReservedSearchParam(k) && (filter === undefined || filter(k))) {
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
  filter?: SearchParamsFilter,
): string {
  const paramStr = sortedRouteParams(params);
  const searchStr = searchParams
    ? sortedSearchString(searchParams, filter)
    : "";

  let key = `${host}${pathname}`;
  if (paramStr) key += `:${paramStr}`;
  if (searchStr) key += `?${searchStr}`;
  return key;
}

/**
 * The prefix of a `key()` result's part in a record key (#975), and of a
 * loader's own `key()` result after its `loader:<id>:` namespace (#1009,
 * loader-cache.ts loaderKeyFromResult).
 */
export const KEY_PART_PREFIX = "key:";

/**
 * A cache() record key, or ppr shell partition, from its parts
 * (CacheScope.resolveKeyFrom, CacheScope.resolvePartition): the `key()`
 * results of the scope's cache() chain, outermost first, then its default
 * parts: the keyGenerator results of enclosing scopes on another store
 * (#974) and, for a record key under a scope without its own `key()`, its
 * default key (or its store's keyGenerator result, #970).
 *
 * Key scheme invariant (#975). A `key()` result is often request input,
 * and a record key has no route or scope discriminator (the store reads
 * `store.get(key)`), so a result that equals another record's key writes
 * one route's content under the other's entry. Before #975 a single
 * `key()` result was stored raw: the header value `doc:localhost/pricing`
 * named /pricing's default-keyed record, and `gold|doc%3Alocalhost%2Fpricing`
 * named gold's nested /pricing record (#970). So every part is encoded:
 *
 * - a `key()` part is `key:` plus `encodeURIComponent(result)`: it starts
 *   with `key:` and holds no `|` and no other `:`;
 * - a default part is `encodeURIComponent(value)`: it holds no `:` or `|`;
 *   an enclosing store's keyGenerator result equal to the default key is an
 *   empty part, so each store keeps its position (CacheScope
 *   positionalParts);
 * - one `key()` part is the key; two or more parts are joined by `|`,
 *   `key()` parts first;
 * - a lone default part stays raw: with no `key()` on the chain the record
 *   key is the default key or the store's keyGenerator result, unchanged.
 *
 * Why nothing collides: the router's default keys (`doc:`, `partial:`,
 * `intercept:`, `response:<type>:`) never start with `key:` and hold a `:`.
 * A namespaced `key()` result starts with `key:` and holds no `|`. A
 * composed key holds a `|` and either starts with `key:` or holds no `:`.
 * Among composed keys, splitting on `|` recovers each part, a part's kind
 * (a `key:` prefix, or no `:` at all) and its value. Pinned by the collision
 * probe in src/cache/__tests__/cache-scope-chain.test.ts. A keyGenerator
 * result is the store's own namespace, as before.
 *
 * Shared with the testing helper `shellCacheKey`, so a test builds the
 * production partition.
 */
export function composeCacheKeys(
  keyResults: readonly string[],
  defaultParts: readonly string[] = [],
): string {
  if (keyResults.length === 0 && defaultParts.length === 1) {
    return defaultParts[0];
  }
  const parts = keyResults.map(
    (result) => KEY_PART_PREFIX + encodeURIComponent(result),
  );
  for (const part of defaultParts) parts.push(encodeURIComponent(part));
  return parts.join("|");
}
