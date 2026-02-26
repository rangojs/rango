/**
 * Loader-Level Caching
 *
 * When a LoaderEntry has a cache config (set via loader(Fn, () => [cache({...})])),
 * this module wraps the loader execution with cache lookup/store using the
 * getItem()/setItem() methods on SegmentCacheStore.
 *
 * Cache key format: loader:{loaderId}:{pathname}:{sortedParams}
 *
 * On hit: returns cached data directly, skips loader execution.
 * On stale hit (SWR): returns stale data, schedules background revalidation.
 * On miss: executes loader, schedules non-blocking cache write.
 */

import type { LoaderEntry } from "../../server/context.js";
import type { HandlerContext } from "../../types.js";
import type { SegmentCacheStore } from "../../cache/types.js";
import { INTERNAL_RANGO_DEBUG } from "../../internal-debug.js";
import { getRequestContext } from "../../server/request-context.js";

const DEFAULT_TTL_SECONDS = 60;

function debugLoaderCacheLog(message: string): void {
  if (INTERNAL_RANGO_DEBUG) {
    console.log(message);
  }
}

function getLoaderCacheKey(
  loaderId: string,
  pathname: string,
  params: Record<string, string>,
): string {
  const paramStr = Object.entries(params)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");

  const base = paramStr ? `${pathname}:${paramStr}` : pathname;
  return `loader:${loaderId}:${base}`;
}

function getLoaderStore(loaderEntry: LoaderEntry): SegmentCacheStore | null {
  const cacheConfig = loaderEntry.cache;
  if (!cacheConfig || cacheConfig.options === false) return null;
  const options = cacheConfig.options;

  // Explicit store from cache() options
  if (options.store) return options.store;

  // App-level store from request context
  return getRequestContext()?._cacheStore ?? null;
}

function getLoaderTtl(
  loaderEntry: LoaderEntry,
  store: SegmentCacheStore,
): number {
  const cacheConfig = loaderEntry.cache;
  if (!cacheConfig || cacheConfig.options === false) return DEFAULT_TTL_SECONDS;
  const options = cacheConfig.options;

  if (options.ttl !== undefined) return options.ttl;
  if (store.defaults?.ttl !== undefined) return store.defaults.ttl;
  return DEFAULT_TTL_SECONDS;
}

function getLoaderSwr(
  loaderEntry: LoaderEntry,
  store: SegmentCacheStore,
): number | undefined {
  const cacheConfig = loaderEntry.cache;
  if (!cacheConfig || cacheConfig.options === false) return undefined;
  const options = cacheConfig.options;

  if (options.swr !== undefined) return options.swr;
  return store.defaults?.swr;
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
  const key = getLoaderCacheKey(loaderId, pathname, ctx.params);
  const ttl = getLoaderTtl(loaderEntry, store);
  const swr = getLoaderSwr(loaderEntry, store);

  // Wrap ctx.use() so cache HIT primes the handler's memoization map.
  // ctx.use() closes over the match context's loaderPromises (not request context's).
  // By intercepting ctx.use(), we inject cached data into the correct map.
  const originalUse = ctx.use;
  const dataPromise = (async () => {
    // Cache lookup
    try {
      const cached = await store.getItem!(key);

      if (cached) {
        const data = JSON.parse(cached.value);

        if (!cached.shouldRevalidate) {
          debugLoaderCacheLog(`[LoaderCache] HIT: ${key}`);
          return data;
        }

        // Stale hit — return stale data, revalidate in background
        debugLoaderCacheLog(`[LoaderCache] STALE: ${key}`);
        const requestCtx = getRequestContext();
        const revalidate = async () => {
          try {
            const fresh = await originalUse(loaderEntry.loader);
            const serialized = JSON.stringify(fresh);
            await store.setItem!(key, serialized, { ttl, swr });
          } catch {
            // Background revalidation failed silently
          }
        };
        if (requestCtx?.waitUntil) {
          requestCtx.waitUntil(revalidate);
        } else {
          revalidate();
        }
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
    const cacheWrite = async () => {
      try {
        const serialized = JSON.stringify(data);
        await store.setItem!(key, serialized, { ttl, swr });
        debugLoaderCacheLog(`[LoaderCache] Cached: ${key}`);
      } catch {
        // Cache write failed silently
      }
    };
    if (requestCtx?.waitUntil) {
      requestCtx.waitUntil(cacheWrite);
    } else {
      await cacheWrite();
    }

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
