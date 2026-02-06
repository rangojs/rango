import { urls, redirect, notFound } from "@rangojs/router";
import { Link } from "@rangojs/router/client";
import {
  NonCachedTestLoader,
  CachedTestLoader,
  InterceptCacheTestLoader,
} from "../loaders.js";
import { CacheTestModal, UseLoaderModal } from "../components/CacheTestModal.js";
import {
  CacheInterceptLayout,
  UseLoaderInterceptLayout,
  ProactiveCacheLayout,
} from "../components/layouts/index.js";

/**
 * Cache test routes URL patterns
 * Routes: cacheTest.*
 */
export const cachePatterns = urls(({ path, layout, intercept, loader, when, cache, notFoundBoundary }) => [
  // Route with NON-cached loader (default behavior)
  path(
    "/cache-test/non-cached-loader",
    async (ctx) => {
      const data = await ctx.use(NonCachedTestLoader);
      return (
        <div data-testid="non-cached-loader-page">
          <Link to="/" data-testid="back-link">
            ← Back to Home
          </Link>
          <h1 data-testid="page-title">Non-Cached Loader Test</h1>
          <p data-testid="loader-count">Loader count: {data.count}</p>
          <p data-testid="loader-message">{data.message}</p>
          <p data-testid="loaded-at">Loaded: {data.loadedAt}</p>
        </div>
      );
    },
    { name: "cacheTest.nonCachedLoader" },
    () => [loader(NonCachedTestLoader)]
  ),

  // Route with CACHED loader (opt-in via cache())
  path(
    "/cache-test/cached-loader",
    async (ctx) => {
      const data = await ctx.use(CachedTestLoader);
      return (
        <div data-testid="cached-loader-page">
          <Link to="/" data-testid="back-link">
            ← Back to Home
          </Link>
          <h1 data-testid="page-title">Cached Loader Test</h1>
          <p data-testid="loader-count">Loader count: {data.count}</p>
          <p data-testid="loader-message">{data.message}</p>
          <p data-testid="loaded-at">Loaded: {data.loadedAt}</p>
        </div>
      );
    },
    { name: "cacheTest.cachedLoader" },
    () => [
      loader(CachedTestLoader, () => [
        cache({ ttl: 600 }),
      ]),
    ]
  ),

  // Cache intercept test routes
  layout(CacheInterceptLayout, () => [
    // Index page for intercept cache testing
    path(
      "/cache-test/intercept",
      () => (
        <div data-testid="cache-intercept-index">
          <h1>Cache Intercept Test</h1>
          <p>Click a link to test intercept caching:</p>
          <ul>
            <li>
              <Link to="/cache-test/intercept/item-a" data-testid="cache-intercept-link-a">
                Item A
              </Link>
            </li>
            <li>
              <Link to="/cache-test/intercept/item-b" data-testid="cache-intercept-link-b">
                Item B
              </Link>
            </li>
          </ul>
        </div>
      ),
      { name: "cacheTest.interceptIndex" }
    ),

    // Detail route wrapped in cache - for direct navigation
    cache({ ttl: 600 }, () => [
      path(
        "/cache-test/intercept/:itemId",
        async (ctx) => {
          const data = await ctx.use(InterceptCacheTestLoader);
          return (
            <div data-testid="cache-intercept-detail">
              <Link to="/cache-test/intercept" data-testid="back-to-intercept-index">
                Back
              </Link>
              <h1>Item Detail: {ctx.params.itemId}</h1>
              <p>This is the full detail page (direct navigation)</p>
              <CacheTestModal data={data} testId="detail-loader-data" />
            </div>
          );
        },
        { name: "cacheTest.interceptDetail" },
        () => [loader(InterceptCacheTestLoader)]
      ),
    ]),

    // Intercept for modal - renders in @cacheModal slot
    intercept(
      "@cacheModal",
      "cacheTest.interceptDetail",
      async (ctx) => {
        const data = await ctx.use(InterceptCacheTestLoader);
        return (
          <CacheTestModal
            data={data}
            testId="cache-test-modal"
          />
        );
      },
      () => [
        when(({ from }) => from.pathname === "/cache-test/intercept"),
        loader(InterceptCacheTestLoader),
      ]
    ),
  ]),

  // useLoader intercept test routes
  layout(UseLoaderInterceptLayout, () => [
    // Index page for useLoader intercept testing
    path(
      "/cache-test/useloader",
      () => (
        <div data-testid="useloader-intercept-index">
          <h1>useLoader Intercept Test</h1>
          <p>Click a link to test useLoader with loader() registration:</p>
          <ul>
            <li>
              <Link to="/cache-test/useloader/item-a" data-testid="useloader-link-a">
                Item A
              </Link>
            </li>
            <li>
              <Link to="/cache-test/useloader/item-b" data-testid="useloader-link-b">
                Item B
              </Link>
            </li>
          </ul>
        </div>
      ),
      { name: "cacheTest.useLoaderIndex" }
    ),

    // Detail route (non-cached) - for direct navigation
    path(
      "/cache-test/useloader/:itemId",
      (ctx) => (
        <div data-testid="useloader-intercept-detail">
          <Link to="/cache-test/useloader" data-testid="back-to-useloader-index">
            Back
          </Link>
          <h1>Item Detail: {ctx.params.itemId}</h1>
          <p>This is the full detail page (direct navigation)</p>
          <UseLoaderModal loader={InterceptCacheTestLoader} testId="detail-useloader-data" />
        </div>
      ),
      { name: "cacheTest.useLoaderDetail" },
      () => [loader(InterceptCacheTestLoader)]
    ),

    // Intercept for modal - client component uses useLoader directly
    intercept(
      "@useLoaderModal",
      "cacheTest.useLoaderDetail",
      () => (
        <UseLoaderModal
          loader={InterceptCacheTestLoader}
          testId="useloader-modal"
        />
      ),
      () => [
        when(({ from }) => from.pathname === "/cache-test/useloader"),
        loader(InterceptCacheTestLoader),
      ]
    ),
  ]),

  // Proactive caching test routes - layout is INSIDE cache boundary
  cache({ ttl: 600 }, () => [
    layout(ProactiveCacheLayout, () => [
      path(
        "/proactive-cache",
        () => (
          <div data-testid="proactive-index-page">
            <h3>Proactive Cache Index</h3>
            <p data-testid="proactive-index-rendered">
              Index rendered at: {new Date().toISOString()}
            </p>
          </div>
        ),
        { name: "proactiveCache.index" }
      ),

      path(
        "/proactive-cache/item-a",
        () => (
          <div data-testid="proactive-item-a-page">
            <h3>Item A</h3>
            <p data-testid="proactive-item-a-rendered">
              Item A rendered at: {new Date().toISOString()}
            </p>
          </div>
        ),
        { name: "proactiveCache.itemA" }
      ),

      path(
        "/proactive-cache/item-b",
        () => (
          <div data-testid="proactive-item-b-page">
            <h3>Item B</h3>
            <p data-testid="proactive-item-b-rendered">
              Item B rendered at: {new Date().toISOString()}
            </p>
          </div>
        ),
        { name: "proactiveCache.itemB" }
      ),
    ]),
  ]),

  // Cache status test routes - only cache 200 responses
  cache({ ttl: 600 }, () => [
    // Not found boundary to catch notFound() calls and return 404
    notFoundBoundary(({ notFound: info }) => (
      <div data-testid="cache-status-not-found-page">
        <Link to="/" data-testid="back-link">← Back to Home</Link>
        <h1 data-testid="cache-status-not-found-title">Not Found (404)</h1>
        <p data-testid="cache-status-not-found-message">{info.message}</p>
      </div>
    )),

    // Success route (200) - should be cached
    path(
      "/cache-status/success",
      () => (
        <div data-testid="cache-status-success-page">
          <Link to="/" data-testid="back-link">← Back to Home</Link>
          <h1 data-testid="cache-status-success-title">Cache Status: Success (200)</h1>
          <p data-testid="cache-status-success-rendered">
            Rendered at: {new Date().toISOString()}
          </p>
        </div>
      ),
      { name: "cacheStatus.success" }
    ),

    // Not Found route (404) - should NOT be cached
    path(
      "/cache-status/not-found",
      () => {
        notFound("This resource does not exist");
      },
      { name: "cacheStatus.notFound" }
    ),

    // Server Error route (500) - should NOT be cached
    path(
      "/cache-status/server-error",
      () => {
        throw new Error("Intentional server error for cache status testing");
      },
      { name: "cacheStatus.serverError" }
    ),

    // Redirect route (308) - should NOT be cached
    path(
      "/cache-status/redirect",
      () => {
        return redirect("/cache-status/redirect-target", 308);
      },
      { name: "cacheStatus.redirect" }
    ),

    // Redirect target route (200) - should be cached
    path(
      "/cache-status/redirect-target",
      () => (
        <div data-testid="cache-status-redirect-target-page">
          <Link to="/" data-testid="back-link">← Back to Home</Link>
          <h1 data-testid="cache-status-redirect-target-title">Cache Status: Redirect Target (200)</h1>
          <p data-testid="cache-status-redirect-target-rendered">
            Rendered at: {new Date().toISOString()}
          </p>
        </div>
      ),
      { name: "cacheStatus.redirectTarget" }
    ),
  ]),
]);
