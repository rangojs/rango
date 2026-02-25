import { redirect, notFound } from "@rangojs/router";
import type { Handler } from "@rangojs/router";
import { Link } from "@rangojs/router/client";
import {
  NonCachedTestLoader,
  CachedTestLoader,
  InterceptCacheTestLoader,
} from "../loaders.js";
import {
  CacheTestModal,
  UseLoaderModal,
} from "../components/CacheTestModal.js";

export const CacheNonCachedLoaderHandler: Handler<
  "cacheTest.nonCachedLoader"
> = async (ctx) => {
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
};

export const CacheCachedLoaderHandler: Handler<
  "cacheTest.cachedLoader"
> = async (ctx) => {
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
};

export const CacheInterceptIndexHandler: Handler<
  "cacheTest.interceptIndex"
> = () => (
  <div data-testid="cache-intercept-index">
    <h1>Cache Intercept Test</h1>
    <p>Click a link to test intercept caching:</p>
    <ul>
      <li>
        <Link
          to="/cache-test/intercept/item-a"
          data-testid="cache-intercept-link-a"
        >
          Item A
        </Link>
      </li>
      <li>
        <Link
          to="/cache-test/intercept/item-b"
          data-testid="cache-intercept-link-b"
        >
          Item B
        </Link>
      </li>
    </ul>
  </div>
);

export const CacheInterceptDetailHandler: Handler<
  "cacheTest.interceptDetail"
> = async (ctx) => {
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
};

export const CacheUseLoaderIndexHandler: Handler<
  "cacheTest.useLoaderIndex"
> = () => (
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
);

export const CacheUseLoaderDetailHandler: Handler<
  "cacheTest.useLoaderDetail"
> = (ctx) => (
  <div data-testid="useloader-intercept-detail">
    <Link to="/cache-test/useloader" data-testid="back-to-useloader-index">
      Back
    </Link>
    <h1>Item Detail: {ctx.params.itemId}</h1>
    <p>This is the full detail page (direct navigation)</p>
    <UseLoaderModal
      loader={InterceptCacheTestLoader}
      testId="detail-useloader-data"
    />
  </div>
);

export const ProactiveCacheIndexHandler: Handler<
  "proactiveCache.index"
> = () => (
  <div data-testid="proactive-index-page">
    <h3>Proactive Cache Index</h3>
    <p data-testid="proactive-index-rendered">
      Index rendered at: {new Date().toISOString()}
    </p>
  </div>
);

export const ProactiveCacheItemAHandler: Handler<
  "proactiveCache.itemA"
> = () => (
  <div data-testid="proactive-item-a-page">
    <h3>Item A</h3>
    <p data-testid="proactive-item-a-rendered">
      Item A rendered at: {new Date().toISOString()}
    </p>
  </div>
);

export const ProactiveCacheItemBHandler: Handler<
  "proactiveCache.itemB"
> = () => (
  <div data-testid="proactive-item-b-page">
    <h3>Item B</h3>
    <p data-testid="proactive-item-b-rendered">
      Item B rendered at: {new Date().toISOString()}
    </p>
  </div>
);

export const CacheStatusSuccessHandler: Handler<"cacheStatus.success"> = () => (
  <div data-testid="cache-status-success-page">
    <Link to="/" data-testid="back-link">
      ← Back to Home
    </Link>
    <h1 data-testid="cache-status-success-title">
      Cache Status: Success (200)
    </h1>
    <p data-testid="cache-status-success-rendered">
      Rendered at: {new Date().toISOString()}
    </p>
  </div>
);

export const CacheStatusNotFoundHandler: Handler<
  "cacheStatus.notFound"
> = () => {
  notFound("This resource does not exist");
};

export const CacheStatusServerErrorHandler: Handler<
  "cacheStatus.serverError"
> = () => {
  throw new Error("Intentional server error for cache status testing");
};

export const CacheStatusRedirectHandler: Handler<
  "cacheStatus.redirect"
> = () => {
  return redirect("/cache-status/redirect-target", 308);
};

export const CacheStatusRedirectTargetHandler: Handler<
  "cacheStatus.redirectTarget"
> = () => (
  <div data-testid="cache-status-redirect-target-page">
    <Link to="/" data-testid="back-link">
      ← Back to Home
    </Link>
    <h1 data-testid="cache-status-redirect-target-title">
      Cache Status: Redirect Target (200)
    </h1>
    <p data-testid="cache-status-redirect-target-rendered">
      Rendered at: {new Date().toISOString()}
    </p>
  </div>
);
