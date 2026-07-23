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
import {
  applyOnResponseCallbacks,
  isCacheableStatus,
  finalizeResponse,
} from "./helpers.js";
import { reportCacheError } from "../cache/cache-error.js";
import { cacheKeyBase } from "../cache/cache-key-utils.js";
import { hasPerClientSignal } from "../browser/cookie-name.js";

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

  // Only cache GET/HEAD — mutations and other methods must not be cached
  // (parity with document-cache.ts GET-only gate; HEAD is read-only).
  const method = reqCtx.request.method;
  if (method !== "GET" && method !== "HEAD") {
    return undefined;
  }

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

  // Default key: response:{type}: + host-namespaced base (sorted search, reserved
  // _rsc*/__* params excluded). Same composition as document/segment tiers so
  // the host-namespacing and search-normalization rules cannot drift.
  let cacheKey = `response:${responseType}:${cacheKeyBase(url.host, url.pathname, url.searchParams, undefined, reqCtx._searchParamsFilter)}`;

  // Priority 1: route-level key() (full override). Priority 2: store-level
  // keyGenerator (modifies the default key).
  //
  // A CONFIGURED key()/keyGenerator that THROWS must DEGRADE TO A MISS, not fall
  // back to the broad default key. The default key is intentionally broad; if the
  // configured key encodes tenant/user/auth state, falling back to the broad key
  // would cache PERSONALIZED output under it and serve it cross-user (cache
  // poisoning). Mirrors the segment-cache behavior (cache-scope.ts lookupRoute):
  // a throwing key degrades to a cache miss, never a collision onto the default
  // slot. The no-key default path is left untouched (the broad key is correct
  // when no key is configured).
  let keyResolutionFailed = false;
  if (cacheScope.config !== false && cacheScope.config.key) {
    try {
      const customKey = await cacheScope.config.key(reqCtx);
      cacheKey = `response:${customKey}`;
    } catch (error) {
      keyResolutionFailed = true;
      reportCacheError(
        error,
        "cache-read",
        "[ResponseCache] Key resolution failed",
        reqCtx,
      );
    }
  } else if (store.keyGenerator) {
    try {
      cacheKey = await store.keyGenerator(reqCtx, cacheKey);
    } catch (error) {
      keyResolutionFailed = true;
      reportCacheError(
        error,
        "cache-read",
        "[ResponseCache] keyGenerator failed",
        reqCtx,
      );
    }
  }

  // Degrade to a MISS: return undefined so the caller runs the route UNCACHED.
  // This early-returns BEFORE _onResponseCallbacks is saved/cleared below, so the
  // pre-handler onResponse callbacks are still intact for the uncached run.
  if (keyResolutionFailed) {
    return undefined;
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
  const applyPreHandlerCallbacks = (response: Response): Response =>
    applyOnResponseCallbacks(savedCallbacks, response);

  // Never store a per-client signal into a SHARED response store. A Set-Cookie
  // (or x-rango-keep-cache) would be replayed to every client on a hit — same
  // Finding #3 as document-cache.ts shouldCacheResponse.
  // Only store GET: HEAD may branch on method; sharing a write slot with GET
  // can poison subsequent GET bodies. HEAD still reads the GET key below.
  const canStore = (response: Response): boolean =>
    method === "GET" &&
    isCacheableStatus(response.status) &&
    !hasPerClientSignal(response.headers);

  // Reject unsafe persisted entries on read (pre-upgrade poison / store bugs).
  const canServeCached = (response: Response): boolean =>
    isCacheableStatus(response.status) && !hasPerClientSignal(response.headers);

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
    if (cached && canServeCached(cached.response)) {
      if (!cached.shouldRevalidate) {
        return applyPreHandlerCallbacks(cached.response);
      }
      // Stale hit (SWR): return cached, revalidate in background.
      reqCtx.waitUntil(async () => {
        try {
          const fresh = finalizeResponse(await executeHandler());
          if (canStore(fresh)) await putFresh(store, fresh);
        } catch (error) {
          reportCacheError(
            error,
            "stale-revalidation",
            "[ResponseCache] background revalidation",
            reqCtx,
          );
        }
      });
      return applyPreHandlerCallbacks(cached.response);
    }
  } catch (error) {
    reportCacheError(
      error,
      "cache-read",
      "[ResponseCache] Cache lookup failed",
      reqCtx,
    );
  }

  // Cache miss: execute the handler and cache the result when storeable.
  const response = finalizeResponse(await executeHandler());
  if (canStore(response)) {
    // Clone SYNCHRONOUSLY here, before returning. The original `response` is
    // handed back to the middleware chain, where mergeResponse rebuilds it as
    // `new Response(response.body, ...)`. Deferring the clone into the waitUntil
    // callback (putFresh(response), which clones inside the async body) raced
    // that rebuild: the background clone() and the foreground body read could
    // interleave and throw "Response body object should not be disturbed or
    // locked" (a flaky 500). Teeing now keeps the returned body independent of
    // the cache write. The SWR path above is unaffected (its `fresh` is created
    // inside the background callback and never returned to the caller).
    const toCache = response.clone();
    reqCtx.waitUntil(async () => {
      try {
        await store.putResponse!(
          cacheKey,
          toCache,
          cacheScope!.ttl,
          cacheScope!.swr,
          responseTags,
        );
      } catch (error) {
        reportCacheError(
          error,
          "cache-write",
          "[ResponseCache] Cache write failed",
          reqCtx,
        );
      }
    });
  }
  return applyPreHandlerCallbacks(response);
}
