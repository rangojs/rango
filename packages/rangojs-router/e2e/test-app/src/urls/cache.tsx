import { urls } from "@rangojs/router";
import { Link } from "@rangojs/router/client";
import {
  NonCachedTestLoader,
  CachedTestLoader,
  InterceptCacheTestLoader,
  ReactNodeTestLoader,
  NullTestLoader,
} from "../loaders.js";
import {
  CacheTestModal,
  UseLoaderModal,
} from "../components/CacheTestModal.js";
import {
  CacheInterceptLayout,
  UseLoaderInterceptLayout,
  ProactiveCacheLayout,
} from "../components/layouts/index.js";
import {
  CacheNonCachedLoaderHandler,
  CacheCachedLoaderHandler,
  CacheHandlerConsumedHandler,
  CacheInterceptIndexHandler,
  CacheInterceptDetailHandler,
  CacheUseLoaderIndexHandler,
  CacheUseLoaderDetailHandler,
  ProactiveCacheIndexHandler,
  ProactiveCacheItemAHandler,
  ProactiveCacheItemBHandler,
  CacheStatusSuccessHandler,
  CacheStatusNotFoundHandler,
  CacheStatusServerErrorHandler,
  CacheStatusRedirectHandler,
  CacheStatusRedirectTargetHandler,
  CacheReactNodeCachedHandler,
  CacheReactNodeNonCachedHandler,
  CacheNullCachedHandler,
  CacheNullNonCachedHandler,
} from "./cache.handlers.js";

/**
 * Cache test routes URL patterns
 * Routes: cacheTest.*
 */
export const cachePatterns = urls(
  ({ path, layout, intercept, loader, cache, notFoundBoundary }) => [
    // Route with NON-cached loader (default behavior)
    path(
      "/cache-test/non-cached-loader",
      CacheNonCachedLoaderHandler,
      { name: "cacheTest.nonCachedLoader" },
      () => [loader(NonCachedTestLoader)],
    ),

    // Route with CACHED loader (opt-in via cache())
    path(
      "/cache-test/cached-loader",
      CacheCachedLoaderHandler,
      { name: "cacheTest.cachedLoader" },
      () => [loader(CachedTestLoader, () => [cache({ ttl: 600 })])],
    ),

    // Consumption-lane rule, cache() tier: a route-level cache() scope whose
    // HANDLER consumes an UNCACHED loader via ctx.use — the value is a BAKED
    // copy, frozen into the cached segments on every hit. PPR twin:
    // /shell-cache/slot-use (semantic matrix row PPR3).
    cache({ ttl: 600 }, () => [
      path("/cache-test/handler-consumed", CacheHandlerConsumedHandler, {
        name: "cacheTest.handlerConsumed",
      }),
    ]),

    // Cache intercept test routes
    layout(CacheInterceptLayout, () => [
      path("/cache-test/intercept", CacheInterceptIndexHandler, {
        name: "cacheTest.interceptIndex",
      }),

      // Detail route wrapped in cache - for direct navigation
      cache({ ttl: 600 }, () => [
        path(
          "/cache-test/intercept/:itemId",
          CacheInterceptDetailHandler,
          { name: "cacheTest.interceptDetail" },
          () => [loader(InterceptCacheTestLoader)],
        ),
      ]),

      // Intercept for modal - renders in @cacheModal slot
      intercept(
        "@cacheModal",
        ".cacheTest.interceptDetail",
        async (ctx) => {
          const data = await ctx.use(InterceptCacheTestLoader);
          return <CacheTestModal data={data} testId="cache-test-modal" />;
        },
        { when: ({ from }) => from.pathname === "/cache-test/intercept" },
        () => [loader(InterceptCacheTestLoader)],
      ),
    ]),

    // useLoader intercept test routes
    layout(UseLoaderInterceptLayout, () => [
      path("/cache-test/useloader", CacheUseLoaderIndexHandler, {
        name: "cacheTest.useLoaderIndex",
      }),

      path(
        "/cache-test/useloader/:itemId",
        CacheUseLoaderDetailHandler,
        { name: "cacheTest.useLoaderDetail" },
        () => [loader(InterceptCacheTestLoader)],
      ),

      // Intercept for modal - client component uses useLoader directly
      intercept(
        "@useLoaderModal",
        ".cacheTest.useLoaderDetail",
        () => (
          <UseLoaderModal
            loader={InterceptCacheTestLoader}
            testId="useloader-modal"
          />
        ),
        { when: ({ from }) => from.pathname === "/cache-test/useloader" },
        () => [loader(InterceptCacheTestLoader)],
      ),
    ]),

    // Proactive caching test routes - layout is INSIDE cache boundary
    cache({ ttl: 600 }, () => [
      layout(ProactiveCacheLayout, () => [
        path("/proactive-cache", ProactiveCacheIndexHandler, {
          name: "proactiveCache.index",
        }),
        path("/proactive-cache/item-a", ProactiveCacheItemAHandler, {
          name: "proactiveCache.itemA",
        }),
        path("/proactive-cache/item-b", ProactiveCacheItemBHandler, {
          name: "proactiveCache.itemB",
        }),
      ]),
    ]),

    // Cache status test routes - only cache 200 responses
    cache({ ttl: 600 }, () => [
      // Not found boundary to catch notFound() calls and return 404
      notFoundBoundary(({ notFound: info }) => (
        <div data-testid="cache-status-not-found-page">
          <Link to="/" data-testid="back-link">
            ← Back to Home
          </Link>
          <h1 data-testid="cache-status-not-found-title">Not Found (404)</h1>
          <p data-testid="cache-status-not-found-message">{info.message}</p>
        </div>
      )),

      path("/cache-status/success", CacheStatusSuccessHandler, {
        name: "cacheStatus.success",
      }),
      path("/cache-status/not-found", CacheStatusNotFoundHandler, {
        name: "cacheStatus.notFound",
      }),
      path("/cache-status/server-error", CacheStatusServerErrorHandler, {
        name: "cacheStatus.serverError",
      }),
      path("/cache-status/redirect", CacheStatusRedirectHandler, {
        name: "cacheStatus.redirect",
      }),
      path("/cache-status/redirect-target", CacheStatusRedirectTargetHandler, {
        name: "cacheStatus.redirectTarget",
      }),
    ]),
    // Response route caching test: cache() DSL with path.json()
    // responseType must be part of the cache key so different response types
    // at the same path produce distinct cache entries.
    cache({ ttl: 600 }, () => [
      path.json(
        "/cache-response-type/data/:id",
        async (ctx) => ({
          id: ctx.params.id,
          ts: Date.now(),
          rand: Math.random(),
          type: "json",
        }),
        { name: "cacheTest.responseTypeJson" },
      ),
      path.text(
        "/cache-response-type/data/:id",
        async (ctx) => `text:${ctx.params.id}:${Date.now()}:${Math.random()}`,
        { name: "cacheTest.responseTypeText" },
      ),
    ]),

    // ReactNode and null loader return type tests
    path(
      "/cache-test/react-node-cached",
      CacheReactNodeCachedHandler,
      { name: "cacheTest.reactNodeCached" },
      () => [loader(ReactNodeTestLoader, () => [cache({ ttl: 600 })])],
    ),
    path(
      "/cache-test/react-node-non-cached",
      CacheReactNodeNonCachedHandler,
      { name: "cacheTest.reactNodeNonCached" },
      () => [loader(ReactNodeTestLoader)],
    ),
    path(
      "/cache-test/null-cached",
      CacheNullCachedHandler,
      { name: "cacheTest.nullCached" },
      () => [loader(NullTestLoader, () => [cache({ ttl: 600 })])],
    ),
    path(
      "/cache-test/null-non-cached",
      CacheNullNonCachedHandler,
      { name: "cacheTest.nullNonCached" },
      () => [loader(NullTestLoader)],
    ),

    // Non-200 status caching test: verify isCacheableStatus behavior.
    // 404 responses are cacheable, 500 responses are not.
    cache({ ttl: 600 }, () => [
      // Handler returns a 404 Response directly — should be cached
      path.json(
        "/cache-status-json/not-found",
        async () => {
          return new Response(
            JSON.stringify({
              error: "not found",
              ts: Date.now(),
              rand: Math.random(),
            }),
            { status: 404, headers: { "content-type": "application/json" } },
          );
        },
        { name: "cacheTest.statusJson404" },
      ),
      // Handler returns a 500 Response directly — should NOT be cached
      path.json(
        "/cache-status-json/server-error",
        async () => {
          return new Response(
            JSON.stringify({
              error: "server error",
              ts: Date.now(),
              rand: Math.random(),
            }),
            { status: 500, headers: { "content-type": "application/json" } },
          );
        },
        { name: "cacheTest.statusJson500" },
      ),
    ]),
    // Search-params cache isolation: same path + different ?page must produce
    // separate cache entries. Verifies that cache keys include search params.
    cache({ ttl: 600 }, () => [
      path(
        "/cache-test/search-params",
        (ctx) => {
          const page = ctx.searchParams.get("page") ?? "none";
          return (
            <div>
              <h1 data-testid="search-page-title">Search Params Cache Test</h1>
              <p data-testid="search-page-value">page:{page}</p>
              <p data-testid="search-page-ts">{Date.now()}</p>
              <nav>
                <Link
                  to="/cache-test/search-params?page=1"
                  data-testid="page-link-1"
                >
                  Page 1
                </Link>
                <Link
                  to="/cache-test/search-params?page=2"
                  data-testid="page-link-2"
                >
                  Page 2
                </Link>
              </nav>
            </div>
          );
        },
        { name: "cacheTest.searchParams" },
      ),
    ]),
  ],
);
