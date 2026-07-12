/**
 * Global search-param cache-key filtering (`cache.searchParams` on the
 * handler/createRouter cache config).
 *
 * Controls WHICH query params participate in default cache-key generation
 * across every tier that keys by URL (segment, document, response, PPR shell,
 * "use cache" ctx normalization, prerendered-shell manifest matching). The
 * filter affects cache keys ONLY -- `ctx.searchParams` and the request URL are
 * untouched, handlers and loaders still see the full query string.
 *
 * Design doc: docs/design/caching.md ("Search param filtering").
 *
 * The footgun this must not soften: excluding a param is a promise that
 * rendered output does not depend on it. If it does, the first variant is
 * cached and served to everyone (the classic CDN cache-key mistake). The
 * default therefore stays "all" -- correct by default, opt into collapsing.
 */

/**
 * `cache.searchParams` config value.
 *
 * - `"all"` (default) -- every non-reserved param keys the cache (today's
 *   behavior; reserved = the router's own `_rsc*` / `__` allowlist params,
 *   see cache-key-utils.ts).
 * - `"none"` -- query params never key the cache.
 * - `{ include }` -- allowlist: only the named params key the cache.
 * - `{ exclude }` -- denylist: every param except the named ones keys the cache.
 *
 * Names match exactly, plus a `*` SUFFIX wildcard (`"utm_*"` matches every
 * param starting with `utm_`). No RegExp: keeps the config serializable and
 * deterministic. `include` + `exclude` together is unrepresentable -- the
 * union forces exactly one mode.
 */
export type CacheSearchParams =
  | "all"
  | "none"
  | { include: readonly string[]; exclude?: never }
  | { exclude: readonly string[]; include?: never };

/**
 * Compiled form of a `CacheSearchParams` config: returns true when the param
 * name should participate in the cache key. `undefined` means "no filter"
 * ("all") so the unfiltered path stays byte-identical to the pre-feature key
 * format (cacheKeyBase output is byte-stable by contract).
 */
export type SearchParamsFilter = (name: string) => boolean;

/**
 * Well-known tracking/click-id params that fragment caches without changing
 * rendered output for (almost) every app. Exported so the common case is one
 * line: `searchParams: { exclude: TRACKING_SEARCH_PARAMS }`.
 *
 * Sources: Google (gclid/gclsrc/dclid/gbraid/wbraid + utm_*), Meta (fbclid),
 * Microsoft (msclkid), TikTok (ttclid), Twitter/X (twclid), LinkedIn
 * (li_fat_id), Mailchimp (mc_cid/mc_eid), Instagram (igshid), Yandex (yclid),
 * HubSpot (_hsenc/_hsmi).
 */
export const TRACKING_SEARCH_PARAMS: readonly string[] = [
  "utm_*",
  "gclid",
  "gclsrc",
  "dclid",
  "gbraid",
  "wbraid",
  "fbclid",
  "msclkid",
  "ttclid",
  "twclid",
  "li_fat_id",
  "mc_cid",
  "mc_eid",
  "igshid",
  "yclid",
  "_hsenc",
  "_hsmi",
];

const NONE_FILTER: SearchParamsFilter = () => false;

/**
 * Build a name matcher from a pattern list: exact names into a Set, `*`-suffix
 * patterns into prefix strings. Only a TRAILING `*` is a wildcard; a `*`
 * anywhere else is matched literally (documented in CacheSearchParams).
 */
function compileMatcher(
  patterns: readonly string[],
): (name: string) => boolean {
  const exact = new Set<string>();
  const prefixes: string[] = [];
  for (const pattern of patterns) {
    if (pattern.endsWith("*")) {
      prefixes.push(pattern.slice(0, -1));
    } else {
      exact.add(pattern);
    }
  }
  if (prefixes.length === 0) {
    return (name) => exact.has(name);
  }
  return (name) =>
    exact.has(name) || prefixes.some((prefix) => name.startsWith(prefix));
}

/**
 * Compile a `cache.searchParams` config into a predicate, once per resolved
 * cache config (handler.ts). Returns `undefined` for the default ("all") so
 * every call site can cheaply skip filtering and keep the shipped key format
 * byte-stable.
 */
export function compileSearchParamsFilter(
  config: CacheSearchParams | undefined,
): SearchParamsFilter | undefined {
  if (config === undefined || config === "all") return undefined;
  if (config === "none") return NONE_FILTER;
  if (config.include !== undefined) return compileMatcher(config.include);
  const excluded = compileMatcher(config.exclude ?? []);
  return (name) => !excluded(name);
}
