import { Suspense } from "react";
import {
  createVar,
  urls,
  type HandlerContext,
  type Middleware,
} from "@rangojs/router";
import { MemorySegmentCacheStore } from "@rangojs/router/cache";
import { Link, Outlet, ParallelOutlet } from "@rangojs/router/client";
import { onErrorLog } from "../error-log.js";
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
import {
  LoaderKeyCraftedLoader,
  LoaderKeyVictimLoader,
} from "./loader-cache-key-loader.js";

// Render counts for /cache-test/outer-live (issue #906). A cache HIT skips the
// route handler, so its count holds; the layout above the boundary re-runs.
let outerLiveLayoutRenders = 0;
let outerLiveRouteRenders = 0;

// /cache-test/nested-key* (issue #970): the tier the page served and its run
// count, which a HIT replays unchanged.
let nestedKeyRenders = 0;

function nestedKeyTier(ctx: { request: Request }): string {
  return ctx.request.headers.get("x-cache-tier") ?? "none";
}

// The pages under the keyed cache() render middleware's copy of the request
// headers (issue #976: a handler read of ctx.request.headers under cache()
// throws); the key() and the keyGenerator read the headers themselves.
const CacheTier = createVar<string>();
const CacheLocale = createVar<string>();

const copyCacheHeaders: Middleware = async (ctx, next) => {
  ctx.set(CacheTier, nestedKeyTier(ctx));
  ctx.set(CacheLocale, crossStoreLocale(ctx));
  return next();
};

function NestedKeyPage(ctx: HandlerContext) {
  return (
    <p data-testid="nested-key-render">
      {`${ctx.get(CacheTier)}:${++nestedKeyRenders}`}
    </p>
  );
}

function NestedKeySiblingPage(ctx: HandlerContext) {
  return (
    <p data-testid="nested-key-render">
      {`sibling-${ctx.get(CacheTier)}:${++nestedKeyRenders}`}
    </p>
  );
}

// /cache-test/nested-condition and /cache-test/nested-tags (issue #974): a
// run count a HIT replays unchanged. /cache-test/raw-key* (issue #975): runs
// of two cached response routes.
let nestedScopeRenders = 0;
let rawKeyRuns = 0;

function NestedScopePage() {
  return (
    <p data-testid="nested-scope-render">{`run:${++nestedScopeRenders}`}</p>
  );
}

// /cache-test/cross-store (issue #974): the outer cache()'s store partitions
// by locale; the inner cache() writes to the app store.
function crossStoreLocale(ctx: { request: Request }): string {
  return ctx.request.headers.get("x-cache-locale") ?? "none";
}

const crossStoreLocaleStore = new MemorySegmentCacheStore({
  keyGenerator: (ctx, defaultKey) => `${defaultKey}|${crossStoreLocale(ctx)}`,
});

function CrossStorePage(ctx: HandlerContext) {
  return (
    <p data-testid="nested-scope-render">
      {`${ctx.get(CacheLocale)}:${++nestedScopeRenders}`}
    </p>
  );
}

// /cache-test/loader-key-* (issue #1009): the loader's value, and the
// victim loader's id and the router's id, which its default key carries.
async function LoaderKeyVictimPage(ctx: HandlerContext<{ probe: string }>) {
  const { from, stamp } = await ctx.use(LoaderKeyVictimLoader);
  const { router } = await import("../router.js");
  return (
    <div>
      <p data-testid="nested-scope-render">{`${from}:${stamp}`}</p>
      <p data-testid="loader-key-victim-id">{LoaderKeyVictimLoader.$$id}</p>
      <p data-testid="cache-key-router-id">{router.id}</p>
    </div>
  );
}

async function LoaderKeyCraftedPage(ctx: HandlerContext) {
  const { from, stamp } = await ctx.use(LoaderKeyCraftedLoader);
  return <p data-testid="nested-scope-render">{`${from}:${stamp}`}</p>;
}

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

// /cache-test/flight-error (issue #909): handler runs per ?k=; the boundary's
// own store lets the status route see whether the write stored.
const flightErrorRuns = new Map<string, number>();
const flightErrorStore = new MemorySegmentCacheStore();

async function FlightErrorReviews({ k, run }: { k: string; run: number }) {
  await Promise.resolve();
  if (run === 1) throw new Error(`flight-error reviews down (k=${k})`);
  return <p data-testid="flight-error-reviews">reviews ok</p>;
}

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
    middleware,
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

    // A cache() nested in a keyed cache() keys its records within the outer
    // key() partition (issue #970): without a key() of its own it composes the
    // tier partition with its own default key, so its two routes keep their
    // own records though the outer key() names no route; with one, the key()
    // results compose. The probe gives each test its own entries.
    middleware(copyCacheHeaders, () => [
      cache(
        {
          ttl: 600,
          key: (ctx) =>
            `nested-key:${nestedKeyTier(ctx)}?${ctx.url.searchParams.get("probe") ?? ""}`,
        },
        () => [
          cache({ ttl: 600 }, () => [
            path("/cache-test/nested-key", NestedKeyPage, {
              name: "cacheTest.nestedKey",
            }),
            path("/cache-test/nested-key-sibling", NestedKeySiblingPage, {
              name: "cacheTest.nestedKeySibling",
            }),
          ]),
          cache(
            {
              ttl: 600,
              key: (ctx) =>
                `variant:${ctx.url.searchParams.get("variant") ?? "none"}`,
            },
            () => [
              path("/cache-test/nested-key-composed", NestedKeyPage, {
                name: "cacheTest.nestedKeyComposed",
              }),
            ],
          ),
        ],
      ),
    ]),

    // An outer condition() gates the cache() nested in it (issue #974): a
    // request it refuses (x-cache-bypass: 1) renders live, and neither reads
    // nor writes the inner record.
    cache(
      {
        condition: (ctx) => ctx.request.headers.get("x-cache-bypass") !== "1",
      },
      () => [
        cache({ ttl: 600 }, () => [
          path("/cache-test/nested-condition", NestedScopePage, {
            name: "cacheTest.nestedCondition",
          }),
        ]),
      ],
    ),

    // The outer cache()'s tags tag the record of the cache() nested in it
    // (issue #974): updateTag() of the outer tag evicts it. The probe gives
    // each test its own tag and record.
    cache(
      {
        tags: (ctx) => [
          `nested-outer:${ctx.url.searchParams.get("probe") ?? ""}`,
        ],
      },
      () => [
        cache({ ttl: 600, tags: ["nested-inner"] }, () => [
          path("/cache-test/nested-tags", NestedScopePage, {
            name: "cacheTest.nestedTags",
          }),
        ]),
      ],
    ),

    // An outer cache({ store }) whose keyGenerator partitions by locale
    // partitions the cache() nested in it on the app store (issue #974): a
    // locale never reads another locale's inner record.
    middleware(copyCacheHeaders, () => [
      cache({ store: crossStoreLocaleStore }, () => [
        cache({ ttl: 600 }, () => [
          path("/cache-test/cross-store", CrossStorePage, {
            name: "cacheTest.crossStore",
          }),
        ]),
      ]),
    ]),

    // A key() returning request input as is (issue #975): its result is
    // namespaced, so a header value spelling the victim route's default key
    // (`json:<host>/cache-test/raw-key-victim?probe=...`) can no longer write
    // this route's body under the victim's entry.
    cache(
      { ttl: 600, key: (ctx) => ctx.request.headers.get("x-raw-key") ?? "" },
      () => [
        path.json(
          "/cache-test/raw-key",
          () => ({ from: "raw-key", run: ++rawKeyRuns }),
          { name: "cacheTest.rawKey" },
        ),
      ],
    ),
    cache({ ttl: 600 }, () => [
      path.json(
        "/cache-test/raw-key-victim",
        () => ({ from: "victim", run: ++rawKeyRuns }),
        { name: "cacheTest.rawKeyVictim" },
      ),
    ]),

    // A loader's own cache() with a key() returning request input as is
    // (issue #1009): its result is namespaced by the loader, so a header
    // value spelling the victim loader's default key
    // (`loader:<id>:<host>/cache-test/loader-key-victim/<probe>:probe=<probe>`)
    // neither reads nor overwrites the victim's entry.
    path(
      "/cache-test/loader-key-crafted",
      LoaderKeyCraftedPage,
      { name: "cacheTest.loaderKeyCrafted" },
      () => [
        loader(LoaderKeyCraftedLoader, () => [
          cache({
            ttl: 600,
            key: (ctx) => ctx.request.headers.get("x-loader-key") ?? "",
          }),
        ]),
      ],
    ),
    path(
      "/cache-test/loader-key-victim/:probe",
      LoaderKeyVictimPage,
      { name: "cacheTest.loaderKeyVictim" },
      () => [loader(LoaderKeyVictimLoader, () => [cache({ ttl: 600 })])],
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
        { when: ({ from }) => from.url.pathname === "/cache-test/intercept" },
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
        { when: ({ from }) => from.url.pathname === "/cache-test/useloader" },
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

    // Issue #909: the write must refuse an entry whose async child threw during
    // the write's Flight encode. The first handler run per ?k= passes run=1, so
    // FlightErrorReviews throws in the live render and again in the write's
    // re-render; later runs render.
    cache({ ttl: 600, store: flightErrorStore }, () => [
      path(
        "/cache-test/flight-error",
        (ctx) => {
          const k = ctx.searchParams.get("k") ?? "";
          const run = (flightErrorRuns.get(k) ?? 0) + 1;
          flightErrorRuns.set(k, run);
          return (
            <div data-testid="flight-error-page">
              <p data-testid="flight-error-run">{run}</p>
              <Suspense fallback={<p>loading reviews</p>}>
                <FlightErrorReviews k={k} run={run} />
              </Suspense>
            </div>
          );
        },
        { name: "cacheTest.flightError" },
      ),
    ]),
    // Write outcome for one ?k=: `stored` reads the boundary's own store,
    // `refused` the onError cache-write report naming k.
    path.json(
      "/cache-test/flight-error-status",
      (ctx) => {
        const k = ctx.searchParams.get("k") ?? "";
        const marker = `k=${k}`;
        return {
          stored: flightErrorStore
            .getStats()
            .keys.some((key) => key.includes(marker)),
          refused: onErrorLog.some(
            (e) =>
              e.metadata?.category === "cache-write" &&
              e.message.includes(marker),
          ),
        };
      },
      { name: "cacheTest.flightErrorStatus" },
    ),
  ],
);
