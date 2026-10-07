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

export function isReservedSearchParam(key: string): boolean {
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
 * THE ROUTER RULE (#1065). A key that names one router's output for a host
 * and path starts with the router part, `{encodeURIComponent(routerId)}@`. A
 * key that names a function and its arguments, or a tag, does not.
 *
 * - With the part: PPR shells and the build-shell manifest (buildShellKey,
 *   buildShellManifestKey); route cache() records, the document cache and
 *   response routes (cacheKeyBase); a loader's own cache() entry; a
 *   `"use cache"` entry of a call that takes a ctx (a ctx is one router's:
 *   its variables, env and reverse() map).
 * - Without: a `"use cache"` entry of plain arguments or a bare Request
 *   (requestArgKey); tag markers; a key the app builds itself
 *   (`cache({ key })`, a `keyGenerator`).
 *
 * Why: a host and path do not name a router. A `hostOverride` cookie picks
 * the router and forwards the request unmodified, and a `router.prerender()`
 * warm requests whatever origin it resolved, so two routers on one store
 * built one key and read each other's entry.
 *
 * The id (router.ts) has to be the same in every isolate and in build-time
 * discovery: an explicit `id` and the injected `$$id` are, the `router_{n}`
 * fallback is for a single router only (discover-routers.ts warns about
 * more). Encoded, the id holds no `@` or `/`, and a host holds no `@`, so a
 * key has a router part exactly when its first `@` comes before its first
 * `/`: no id can be chosen to spell another router's key.
 */
export function routerKeyPrefix(routerId: string): string {
  return `${encodeURIComponent(routerId)}@`;
}

/** `{host}{pathname}[:params][?search]`: what follows the router part. */
function hostPathKey(
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
 * Key base of one router's output (the router rule, routerKeyPrefix):
 * `${routerId}@${host}${pathname}[:params][?search]`.
 *
 * The ONE composition of the namespacing rule, shared by the segment tier
 * (cache-scope.ts), the document tier (document-cache.ts), the response tier
 * (rsc/response-cache-serve.ts) and the loader cache so the rule cannot drift
 * between them. Host prefixing matters because VercelCacheStore /
 * MemorySegmentCacheStore key by the raw string (only CFCacheStore adds host
 * internally) -- on a single function serving multiple domains an
 * un-namespaced key bleeds tenant A's cached response to tenant B.
 *
 * Output is BYTE-STABLE by contract: changing the composition silently
 * invalidates every persisted cache entry on upgrade. Callers append their own
 * tier-specific suffixes (`:rsc`/`:html`, segment hash) after this base.
 */
export function cacheKeyBase(
  routerId: string,
  host: string,
  pathname: string,
  searchParams?: URLSearchParams,
  params?: Record<string, string>,
  filter?: SearchParamsFilter,
): string {
  return `${routerKeyPrefix(routerId)}${hostPathKey(host, pathname, searchParams, params, filter)}`;
}

/**
 * cacheKeyBase for the request context `ctx`. rsc/handler.ts sets `_routerId`
 * before the request scope opens and derived contexts inherit it, so a served
 * request always has one. Only a hand-built context has none (a unit test,
 * the runLoader / renderHandler primitives): its key has no router part,
 * which no router's key equals (routerKeyPrefix).
 */
export function requestKeyBase(
  ctx: { readonly _routerId?: string } | null | undefined,
  host: string,
  pathname: string,
  searchParams?: URLSearchParams,
  params?: Record<string, string>,
  filter?: SearchParamsFilter,
): string {
  const routerId = ctx?._routerId;
  return routerId === undefined
    ? hostPathKey(host, pathname, searchParams, params, filter)
    : cacheKeyBase(routerId, host, pathname, searchParams, params, filter);
}

/**
 * The `"use cache"` key part of a bare Request argument: its URL, with no
 * router part (the router rule, routerKeyPrefix).
 */
export function requestArgKey(url: URL, filter?: SearchParamsFilter): string {
  return hostPathKey(
    url.host,
    url.pathname,
    url.searchParams,
    undefined,
    filter,
  );
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
