import { urls } from "@rangojs/router";
import { Link, Outlet, ParallelOutlet } from "@rangojs/router/client";
import {
  NonCachedTestLoader,
  CachedTestLoader,
  DepCrumbProductLoader,
  DepCrumbSiblingLoader,
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
  CacheCachedLoaderDepHandler,
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

// Render counts for /cache-test/outer-live (issue #906). A cache HIT skips the
// route handler, so its count holds; the layout above the boundary re-runs.
let outerLiveLayoutRenders = 0;
let outerLiveRouteRenders = 0;

// Render counts for /cache-test/path-children (issue #912).
let pathChildrenShellRenders = 0;
let pathChildrenRouteRenders = 0;
let pathChildrenChromeRenders = 0;

// Render counts for /cache-test/marker-* and /cache-test/layout-cache (#918).
let markerShellRenders = 0;
let markerBeforeRenders = 0;
let markerAfterRenders = 0;
let markerPromoRenders = 0;
let layoutCacheShellRenders = 0;
let layoutCacheRouteRenders = 0;
let layoutCacheChromeRenders = 0;

/**
 * Cache test routes URL patterns
 * Routes: cacheTest.*
 */
export const cachePatterns = urls(
  ({
    path,
    layout,
    intercept,
    loader,
    cache,
    errorBoundary,
    notFoundBoundary,
  }) => [
    // A layout ABOVE a cache() boundary is live: it renders and writes its
    // header on every request, cache HITs included. Only the route inside the
    // boundary replays from the cache. The entry page sits outside the layout,
    // so its link is a partial navigation that needs the layout rendered.
    path(
      "/cache-test/outer-live-entry",
      () => (
        <Link to="/cache-test/outer-live" data-testid="outer-live-link">
          Outer live
        </Link>
      ),
      { name: "cacheTest.outerLiveEntry" },
    ),
    layout(
      (ctx) => {
        const count = ++outerLiveLayoutRenders;
        ctx.headers.set("x-outer-live-layout", String(count));
        return (
          <div data-testid="outer-live-layout">
            <p data-testid="outer-live-layout-count">{count}</p>
            <Outlet />
          </div>
        );
      },
      () => [
        cache({ ttl: 600 }, () => [
          path(
            "/cache-test/outer-live",
            () => (
              <p data-testid="outer-live-route-count">
                {++outerLiveRouteRenders}
              </p>
            ),
            { name: "cacheTest.outerLive" },
          ),
        ]),
      ],
    ),

    // A cache() among a path's own children caches that path: the route and
    // the layout declared after the cache() replay from the cache, and the
    // layout above the path stays live.
    path(
      "/cache-test/path-children-entry",
      () => (
        <Link to="/cache-test/path-children" data-testid="path-children-link">
          Path children
        </Link>
      ),
      { name: "cacheTest.pathChildrenEntry" },
    ),
    layout(
      () => (
        <div data-testid="path-children-shell">
          <p data-testid="path-children-shell-count">
            {++pathChildrenShellRenders}
          </p>
          <Outlet />
        </div>
      ),
      () => [
        path(
          "/cache-test/path-children",
          () => (
            <p data-testid="path-children-route-count">
              {++pathChildrenRouteRenders}
            </p>
          ),
          { name: "cacheTest.pathChildren" },
          () => [
            cache({ ttl: 600 }),
            layout(() => (
              <div data-testid="path-children-chrome">
                <p data-testid="path-children-chrome-count">
                  {++pathChildrenChromeRenders}
                </p>
                <Outlet />
              </div>
            )),
          ],
        ),
      ],
    ),

    // A layout after a bare cache() wraps every route of the enclosing
    // layout: live on the route before the marker, cached with the route after
    // it. A cache() inside a routeless layout in a path caches that path.
    path(
      "/cache-test/orphan-entry",
      () => (
        <nav>
          <Link to="/cache-test/marker-before" data-testid="marker-before-link">
            Marker before
          </Link>
          <Link to="/cache-test/marker-after" data-testid="marker-after-link">
            Marker after
          </Link>
          <Link to="/cache-test/layout-cache" data-testid="layout-cache-link">
            Layout cache
          </Link>
        </nav>
      ),
      { name: "cacheTest.orphanEntry" },
    ),
    layout(
      () => (
        <div data-testid="marker-shell">
          <p data-testid="marker-shell-count">{++markerShellRenders}</p>
          <Outlet />
        </div>
      ),
      () => [
        path(
          "/cache-test/marker-before",
          () => <p data-testid="marker-route-count">{++markerBeforeRenders}</p>,
          { name: "cacheTest.markerBefore" },
        ),
        cache({ ttl: 600 }),
        layout(() => (
          <div data-testid="marker-promo">
            <p data-testid="marker-promo-count">{++markerPromoRenders}</p>
            <Outlet />
          </div>
        )),
        path(
          "/cache-test/marker-after",
          () => <p data-testid="marker-route-count">{++markerAfterRenders}</p>,
          { name: "cacheTest.markerAfter" },
        ),
      ],
    ),
    // For the routes before the marker, the layout after it is nested one
    // level under the marker in the shell's layout[]: its errorBoundary() and
    // intercept() are found there (issue #926).
    layout(
      () => (
        <div data-testid="nested-orphan-shell">
          <Outlet />
        </div>
      ),
      () => [
        path(
          "/cache-test/nested-orphan",
          () => (
            <nav>
              <Link
                to="/cache-test/nested-orphan/throw"
                data-testid="nested-orphan-throw-link"
              >
                Throw
              </Link>
              <Link
                to="/cache-test/nested-orphan/photo/1"
                data-testid="nested-orphan-photo-link"
              >
                Photo
              </Link>
            </nav>
          ),
          { name: "cacheTest.nestedOrphanIndex" },
        ),
        path(
          "/cache-test/nested-orphan/throw",
          () => {
            throw new Error("nested orphan route failed");
          },
          { name: "cacheTest.nestedOrphanThrow" },
        ),
        path(
          "/cache-test/nested-orphan/photo/:id",
          (ctx) => (
            <p data-testid="nested-orphan-photo-page">photo {ctx.params.id}</p>
          ),
          { name: "cacheTest.nestedOrphanPhoto" },
        ),
        cache({ ttl: 600 }),
        layout(
          () => (
            <div data-testid="nested-orphan-host">
              <Outlet />
              <ParallelOutlet name="@nestedOrphanModal" />
            </div>
          ),
          () => [
            errorBoundary(
              <p data-testid="nested-orphan-error">nested orphan error</p>,
            ),
            intercept(
              "@nestedOrphanModal",
              ".cacheTest.nestedOrphanPhoto",
              (ctx) => (
                <p data-testid="nested-orphan-modal">modal {ctx.params.id}</p>
              ),
            ),
          ],
        ),
      ],
    ),
    layout(
      () => (
        <div data-testid="layout-cache-shell">
          <p data-testid="layout-cache-shell-count">
            {++layoutCacheShellRenders}
          </p>
          <Outlet />
        </div>
      ),
      () => [
        path(
          "/cache-test/layout-cache",
          () => (
            <p data-testid="layout-cache-route-count">
              {++layoutCacheRouteRenders}
            </p>
          ),
          { name: "cacheTest.layoutCache" },
          () => [
            layout(
              () => (
                <div data-testid="layout-cache-chrome">
                  <p data-testid="layout-cache-chrome-count">
                    {++layoutCacheChromeRenders}
                  </p>
                  <Outlet />
                </div>
              ),
              () => [cache({ ttl: 600 })],
            ),
          ],
        ),
      ],
    ),

    // Route with NON-cached loader (default behavior)
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

    // A cached loader's ctx.use dependency, also read by an uncached sibling
    // loader: its crumb appears once on the MISS and on the HIT, where the
    // sibling's live run replaces the replayed crumb. ssr: false puts every
    // push in the document.
    path(
      "/cache-test/cached-loader-dep",
      CacheCachedLoaderDepHandler,
      { name: "cacheTest.cachedLoaderDep" },
      () => [
        loader(DepCrumbProductLoader, { ssr: false }, () => [
          cache({ ttl: 600 }),
        ]),
        loader(DepCrumbSiblingLoader, { ssr: false }),
      ],
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
