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
 *   3. loader:{loaderId}:{pathname}:{sortedParams} — default
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
import type { SegmentCacheStore } from "../../cache/types.js";
import { INTERNAL_RANGO_DEBUG } from "../../internal-debug.js";
import {
  getRequestContext,
  _getRequestContext,
} from "../../server/request-context.js";
import { sortedRouteParams } from "../../cache/cache-key-utils.js";
import {
  resolveTtl,
  resolveSwrWindow,
  DEFAULT_ROUTE_TTL,
} from "../../cache/cache-policy.js";
import { runBackground } from "../../cache/background-task.js";
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
  pathname: string,
  params: Record<string, string>,
): string {
  const paramStr = sortedRouteParams(params);
  const base = paramStr ? `${pathname}:${paramStr}` : pathname;
  return `loader:${loaderId}:${base}`;
}

/**
 * Resolve cache key using the same 3-tier priority as CacheScope.resolveKey():
 * 1. options.key (full override)
 * 2. store.keyGenerator (modifies default)
 * 3. Default loader key
 */
async function resolveLoaderKey(
  loaderEntry: LoaderEntry,
  store: SegmentCacheStore,
  loaderId: string,
  pathname: string,
  params: Record<string, string>,
): Promise<string> {
  const options = loaderEntry.cache!.options;
  if (options === false) {
    return getDefaultLoaderCacheKey(loaderId, pathname, params);
  }

  const requestCtx = getRequestContext();

  // Priority 1: Route-level key function (full override)
  if (options.key && requestCtx) {
    try {
      return await options.key(requestCtx);
    } catch (error) {
      console.error(
        `[LoaderCache] Custom key function failed, using default:`,
        error,
      );
    }
  }

  const defaultKey = getDefaultLoaderCacheKey(loaderId, pathname, params);

  // Priority 2: Store-level keyGenerator
  if (store.keyGenerator && requestCtx) {
    try {
      return await store.keyGenerator(requestCtx, defaultKey);
    } catch (error) {
      console.error(
        `[LoaderCache] Store keyGenerator failed, using default:`,
        error,
      );
    }
  }

  // Priority 3: Default key
  return defaultKey;
}

/**
 * Resolve tags from cache options (static array or function).
 * Fails open: a thrown tag callback falls back to no tags rather than
 * aborting the request, consistent with resolveLoaderKey().
 */
function resolveTags(loaderEntry: LoaderEntry): string[] | undefined {
  const options = loaderEntry.cache?.options;
  if (!options || !options.tags) return undefined;

  if (typeof options.tags === "function") {
    const requestCtx = getRequestContext();
    if (!requestCtx) return undefined;
    try {
      return options.tags(requestCtx);
    } catch (error) {
      console.error(
        `[LoaderCache] Tags function failed, caching without tags:`,
        error,
      );
      return undefined;
    }
  }

  return options.tags;
}

function getLoaderStore(loaderEntry: LoaderEntry): SegmentCacheStore | null {
  const cacheConfig = loaderEntry.cache;
  if (!cacheConfig || cacheConfig.options === false) return null;
  const options = cacheConfig.options;

  // Explicit store from cache() options
  if (options.store) return options.store;

  // App-level store from request context
  return _getRequestContext()?._cacheStore ?? null;
}

function getLoaderTtl(
  loaderEntry: LoaderEntry,
  store: SegmentCacheStore,
): number {
  const cacheConfig = loaderEntry.cache;
  if (!cacheConfig || cacheConfig.options === false) return DEFAULT_ROUTE_TTL;
  return resolveTtl(cacheConfig.options.ttl, store.defaults, DEFAULT_ROUTE_TTL);
}

function getLoaderSwr(
  loaderEntry: LoaderEntry,
  store: SegmentCacheStore,
): number | undefined {
  const cacheConfig = loaderEntry.cache;
  if (!cacheConfig || cacheConfig.options === false) return undefined;
  const swr = resolveSwrWindow(cacheConfig.options.swr, store.defaults);
  return swr || undefined;
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
  const ttl = getLoaderTtl(loaderEntry, store);
  const swr = getLoaderSwr(loaderEntry, store);
  const tags = resolveTags(loaderEntry);

  // Wrap ctx.use() so cache HIT primes the handler's memoization map.
  // ctx.use() closes over the match context's loaderPromises (not request context's).
  // By intercepting ctx.use(), we inject cached data into the correct map.
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

    // Cache lookup
    try {
      const cached = await store.getItem!(key);

      if (cached) {
        const data = await codec.deserializeResult(cached.value);

        if (!cached.shouldRevalidate) {
          debugLoaderCacheLog(`[LoaderCache] HIT: ${key}`);
          return data;
        }

        // Stale hit — return stale data, revalidate in background
        debugLoaderCacheLog(`[LoaderCache] STALE: ${key}`);
        const requestCtx = getRequestContext();
        runBackground(
          requestCtx,
          async () => {
            try {
              const fresh = await originalUse(loaderEntry.loader);
              const serialized = await codec.serializeResult(fresh);
              if (serialized !== null) {
                await store.setItem!(key, serialized, { ttl, swr, tags });
              }
            } catch {
              // Background revalidation failed silently
            }
          },
          true,
        );
        return data;
      }
    } catch {
      // Cache lookup failed, fall through to fresh execution
    }

    // Cache miss — execute loader via ctx.use() (which memoizes it)
    debugLoaderCacheLog(`[LoaderCache] MISS: ${key}`);
    const data = await originalUse(loaderEntry.loader);

    // Non-blocking cache write
    const requestCtx = getRequestContext();
    await runBackground(
      requestCtx,
      async () => {
        try {
          const serialized = await codec.serializeResult(data);
          if (serialized !== null) {
            await store.setItem!(key, serialized, { ttl, swr, tags });
            debugLoaderCacheLog(`[LoaderCache] Cached: ${key}`);
          }
        } catch {
          // Cache write failed silently
        }
      },
      true,
    );

    return data;
  })();

  // Temporarily replace ctx.use() so the handler's call returns cached data.
  // This is needed because ctx.use() closes over the match context's loaderPromises
  // map which is separate from the request context. By wrapping use(), we intercept
  // the handler's call and return the shared dataPromise.
  const wrappedUse = ((item: any) => {
    if (item === loaderEntry.loader || item?.$$id === loaderId) {
      return dataPromise;
    }
    return originalUse(item);
  }) as typeof ctx.use;
  ctx.use = wrappedUse;

  return dataPromise;
}
