/**
 * Loader-Level Caching
 *
 * When a LoaderEntry has a cache config (set via loader(Fn, () => [cache({...})])),
 * this module wraps the loader execution with cache lookup/store using the
 * getItem()/setItem() methods on SegmentCacheStore.
 *
 * Cache key resolution (3-tier, matching CacheScope.resolveKey):
 *   1. options.key(requestCtx) — full override
 *   2. store.keyGenerator(requestCtx, defaultKey) — store-level modification
 *   3. loader:{loaderId}:{host}{pathname}:{sortedParams} — default
 *
 * Values are serialized via RSC Flight (serializeResult/deserializeResult),
 * supporting ReactNode, Promises, null, and all RSC-serializable types.
 *
 * On hit: returns cached data directly, skips loader execution.
 * On stale hit (SWR): returns stale data, schedules background revalidation.
 * On miss: executes loader, schedules non-blocking cache write.
 */

import type { LoaderEntry } from "../../server/context.js";
import type { HandlerContext } from "../../types.js";
import { INTERNAL_RANGO_DEBUG } from "../../internal-debug.js";
import { getRequestContext } from "../../server/request-context.js";
import { sortedRouteParams } from "../../cache/cache-key-utils.js";
import {
  resolveTtl,
  resolveSwrWindow,
  resolveCacheKey,
  resolveCacheStore,
  resolveTagsOption,
  DEFAULT_ROUTE_TTL,
} from "../../cache/cache-policy.js";
import { readThroughItem } from "../../cache/read-through-swr.js";
import { recordRequestTags } from "../../cache/cache-tag.js";
// Lazy-loaded to avoid pulling @vitejs/plugin-rsc/rsc into modules that
// import segment-resolution but never use loader caching.
let _serializeResult: typeof import("../../cache/segment-codec.js").serializeResult;
let _deserializeResult: typeof import("../../cache/segment-codec.js").deserializeResult;
async function getCodec() {
  if (!_serializeResult) {
    const mod = await import("../../cache/segment-codec.js");
    _serializeResult = mod.serializeResult;
    _deserializeResult = mod.deserializeResult;
  }
  return {
    serializeResult: _serializeResult,
    deserializeResult: _deserializeResult,
  };
}

function debugLoaderCacheLog(message: string): void {
  if (INTERNAL_RANGO_DEBUG) {
    console.log(message);
  }
}

function getDefaultLoaderCacheKey(
  loaderId: string,
  host: string,
  pathname: string,
  params: Record<string, string>,
): string {
  const paramStr = sortedRouteParams(params);
  const base = paramStr ? `${pathname}:${paramStr}` : pathname;
  return `loader:${loaderId}:${host}${base}`;
}

/**
 * Resolve cache key using the shared 3-tier priority.
 */
async function resolveLoaderKey(
  loaderEntry: LoaderEntry,
  store: import("../../cache/types.js").SegmentCacheStore,
  loaderId: string,
  pathname: string,
  params: Record<string, string>,
): Promise<string> {
  const options = loaderEntry.cache!.options;
  // The host is part of the loader cache identity, matching the route-level
  // cache (cache-scope getCacheKeyBase: `${host}${pathname}`) and "use cache"
  // (cache-runtime pushes ctx.url.host). Without it, a multi-tenant host router
  // serving the same pathname for different hosts would leak one host's cached
  // loader data to another.
  const host = getRequestContext()?.url?.host ?? "localhost";
  const defaultKey = getDefaultLoaderCacheKey(loaderId, host, pathname, params);
  if (options === false) return defaultKey;
  return resolveCacheKey(options.key, store, defaultKey, "LoaderCache");
}

/**
 * Resolve tags from cache options (static array or function).
 * Fails open: a thrown tag callback falls back to no tags rather than
 * aborting the request. Tags are additive metadata (not identity), so
 * a missing tag does not cause cache collisions.
 */
function resolveTags(loaderEntry: LoaderEntry): string[] | undefined {
  const options = loaderEntry.cache?.options;
  if (!options) return undefined;
  return resolveTagsOption(options.tags, getRequestContext(), "LoaderCache");
}

function getLoaderStore(
  loaderEntry: LoaderEntry,
): import("../../cache/types.js").SegmentCacheStore | null {
  const cacheConfig = loaderEntry.cache;
  if (!cacheConfig || cacheConfig.options === false) return null;
  return resolveCacheStore(cacheConfig.options.store);
}

/**
 * Resolve loader data with optional caching.
 *
 * When the LoaderEntry has no cache config, delegates directly to ctx.use(loader).
 * When cached, checks store first and stores on miss via waitUntil.
 */
export function resolveLoaderData<TEnv>(
  loaderEntry: LoaderEntry,
  ctx: HandlerContext<any, TEnv>,
  pathname: string,
): Promise<any> {
  const cacheConfig = loaderEntry.cache;

  // No cache config or disabled — run fresh (zero overhead path)
  if (!cacheConfig || cacheConfig.options === false) {
    return ctx.use(loaderEntry.loader);
  }

  const store = getLoaderStore(loaderEntry);
  if (!store?.getItem || !store?.setItem) {
    return ctx.use(loaderEntry.loader);
  }

  // Evaluate runtime condition if provided
  const options = cacheConfig.options;
  if (options.condition) {
    const requestCtx = getRequestContext();
    if (requestCtx && !options.condition(requestCtx)) {
      return ctx.use(loaderEntry.loader);
    }
  }

  const loaderId = loaderEntry.loader.$$id;

  const ttl = resolveTtl(options.ttl, store.defaults, DEFAULT_ROUTE_TTL);
  const swrWindow = resolveSwrWindow(options.swr, store.defaults);
  const swr = swrWindow || undefined;
  const tags = resolveTags(loaderEntry);
  recordRequestTags(tags);

  const originalUse = ctx.use;
  const dataPromise = (async () => {
    const codec = await getCodec();
    const key = await resolveLoaderKey(
      loaderEntry,
      store,
      loaderId,
      pathname,
      ctx.params,
    );

    return readThroughItem({
      getItem: (k) => store.getItem!(k),
      setItem: (k, v, o) => store.setItem!(k, v, o),
      key,
      execute: () => originalUse(loaderEntry.loader),
      serialize: (d) => codec.serializeResult(d),
      deserialize: (v) => codec.deserializeResult(v),
      storeOptions: { ttl, swr, tags },
      onHit: () => debugLoaderCacheLog(`[LoaderCache] HIT: ${key}`),
      onStale: () => debugLoaderCacheLog(`[LoaderCache] STALE: ${key}`),
      onMiss: () => debugLoaderCacheLog(`[LoaderCache] MISS: ${key}`),
      onCached: () => debugLoaderCacheLog(`[LoaderCache] Cached: ${key}`),
      host: getRequestContext(),
    });
  })();

  const wrappedUse = ((item: any) => {
    if (item === loaderEntry.loader || item?.$$id === loaderId) {
      return dataPromise;
    }
    return originalUse(item);
  }) as typeof ctx.use;
  ctx.use = wrappedUse;

  return dataPromise;
}
