/**
 * Shared response-route cache serve.
 *
 * Owns the single response-cache contract — cache-scope resolution from the
 * matched entry tree, condition eval, key resolution (route key() > store
 * keyGenerator > default), tag resolution, pre-handler-callback timing, and the
 * fresh-hit / SWR-revalidate / miss-write branches — for BOTH the production
 * response-route handler (rsc/response-route-handler.ts) and the dispatch testing
 * primitive (testing/dispatch.ts), so the two can never drift.
 *
 * Plugin-rsc hazard: cache-scope.ts pulls @vitejs/plugin-rsc (via segment-codec),
 * which the non-Vite unit-test runner cannot resolve, and this module is on the
 * testing barrel's EAGER graph (dispatch imports it). So `createCacheScope` and
 * `resolveCacheTags` are NOT imported here at runtime — they are INJECTED by the
 * caller (production imports them statically; dispatch lazy-imports them only once
 * a response route matches). The only runtime imports here are plugin-rsc-free
 * (helpers' isCacheableStatus/finalizeResponse, traverseBack); cache-scope is a
 * type-only import (erased at build).
 */

import type { CacheScope } from "../cache/cache-scope.js";
import type { PartialCacheOptions } from "../types.js";
import type { RequestContext } from "../server/request-context.js";
import type { SegmentCacheStore } from "../cache/types.js";
import type { EntryCacheConfig, EntryData } from "../server/context.js";
import { traverseBack } from "../router/pattern-matching.js";
import { isCacheableStatus, finalizeResponse } from "./helpers.js";

/** Injected cache-scope builders (kept off this module's runtime import graph). */
export interface CacheScopeDeps {
  createCacheScope: (
    config: EntryCacheConfig | undefined,
    parent?: CacheScope | null,
  ) => CacheScope | null;
  resolveCacheTags: (
    config: PartialCacheOptions | false,
    ctx: RequestContext | undefined,
  ) => string[] | undefined;
}

export interface ServeResponseRouteWithCacheArgs {
  reqCtx: RequestContext;
  manifestEntry: EntryData;
  responseType: string;
  url: URL;
  /** callHandler wrapped by route-level middleware — the unit the cache wraps. */
  executeHandler: () => Promise<Response>;
  deps: CacheScopeDeps;
}

/**
 * Serve a response route through its cache, or return `undefined` when no cache
 * applies (no scope, disabled, condition false, or store lacks get/putResponse)
 * so the caller falls through to a plain `executeHandler()` run.
 *
 * Must run inside runWithRequestContext (reads the ambient request context via
 * the helpers and reqCtx.waitUntil for background writes).
 */
export async function serveResponseRouteWithCache(
  args: ServeResponseRouteWithCacheArgs,
): Promise<Response | undefined> {
  const { reqCtx, manifestEntry, responseType, url, executeHandler, deps } =
    args;

  let cacheScope: CacheScope | null = null;
  for (const entry of traverseBack(manifestEntry)) {
    if (entry.cache) {
      cacheScope = deps.createCacheScope(entry.cache, cacheScope);
    }
  }

  if (!cacheScope?.enabled) return undefined;

  // Evaluate condition — skip the response cache when condition returns false.
  let conditionPassed = true;
  if (cacheScope.config !== false && cacheScope.config.condition) {
    try {
      conditionPassed = !!cacheScope.config.condition(reqCtx);
    } catch {
      conditionPassed = false;
    }
  }

  const store = cacheScope.getStore() ?? reqCtx._cacheStore;
  if (!conditionPassed || !store?.getResponse || !store?.putResponse) {
    return undefined;
  }

  // Build cache key with the response:{type}: prefix (avoids collision with
  // segment keys); include host + url.search so query-driven and multi-host
  // responses cache separately.
  let cacheKey = `response:${responseType}:${url.host}${url.pathname}${url.search}`;

  // Priority 1: route-level key() (full override). Priority 2: store-level
  // keyGenerator (modifies the default key). Both fall back to the default key
  // on failure.
  if (cacheScope.config !== false && cacheScope.config.key) {
    try {
      const customKey = await cacheScope.config.key(reqCtx);
      cacheKey = `response:${customKey}`;
    } catch {
      // Fall back to default key on route-level key failure.
    }
  } else if (store.keyGenerator) {
    try {
      cacheKey = await store.keyGenerator(reqCtx, cacheKey);
    } catch {
      // Fall back to default key on keyGenerator failure.
    }
  }

  // Resolve cache tags for this document entry (static or dynamic) while the
  // request context is available, so the stored entry is tag-invalidatable.
  const responseTags = deps.resolveCacheTags(cacheScope.config, reqCtx);

  // Pre-handler callbacks (registered by app-level middleware before the cache
  // block) are saved and the live array is cleared:
  // createResponseWithMergedHeaders inside the handler eagerly drains whatever is
  // in _onResponseCallbacks, so handler-registered callbacks bake into the cached
  // artifact, while these pre-handler callbacks are applied once per serve on
  // every path (hit + miss).
  const savedCallbacks = reqCtx._onResponseCallbacks;
  reqCtx._onResponseCallbacks = [];
  const applyPreHandlerCallbacks = (response: Response): Response => {
    let result = response;
    for (const callback of savedCallbacks) {
      result = callback(result) ?? result;
    }
    return result;
  };

  const putFresh = (
    store2: SegmentCacheStore,
    fresh: Response,
  ): Promise<void> =>
    store2.putResponse!(
      cacheKey,
      fresh.clone(),
      cacheScope!.ttl,
      cacheScope!.swr,
      responseTags,
    );

  try {
    const cached = await store.getResponse(cacheKey);
    if (cached && isCacheableStatus(cached.response.status)) {
      if (!cached.shouldRevalidate) {
        return applyPreHandlerCallbacks(cached.response);
      }
      // Stale hit (SWR): return cached, revalidate in background.
      reqCtx.waitUntil(async () => {
        try {
          const fresh = finalizeResponse(await executeHandler());
          if (isCacheableStatus(fresh.status)) await putFresh(store, fresh);
        } catch (error) {
          console.error(`[ResponseCache] Revalidation failed:`, error);
        }
      });
      return applyPreHandlerCallbacks(cached.response);
    }
  } catch (error) {
    console.error(`[ResponseCache] Cache lookup failed:`, error);
  }

  // Cache miss: execute the handler and cache the result.
  const response = finalizeResponse(await executeHandler());
  if (isCacheableStatus(response.status)) {
    reqCtx.waitUntil(async () => {
      try {
        await putFresh(store, response);
      } catch (error) {
        console.error(`[ResponseCache] Cache write failed:`, error);
      }
    });
  }
  return applyPreHandlerCallbacks(response);
}
