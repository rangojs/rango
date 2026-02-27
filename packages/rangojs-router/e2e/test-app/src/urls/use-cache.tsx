import { urls, Meta } from "@rangojs/router";
import { isCachedFunction } from "@rangojs/router/cache-runtime";
import { Link, Outlet } from "@rangojs/router/client";
import { getBasicTimestamp, getDataForCategory } from "./use-cache-data.js";
import {
  getShortCachedData,
  fetchWithBreadcrumbs,
  getSlowCachedData,
  getCachedReactNode,
  CachedWithSlots,
  getCachedActionData,
} from "./use-cache-fn.js";
import { InterleaveActionButton } from "../components/InterleaveActionButton.js";
import { Breadcrumbs } from "../handles.js";
import { UseCacheTestLoader } from "../loaders.js";

/**
 * "use cache" test routes.
 *
 * Tests file-level and function-level "use cache" directives,
 * named profiles, tainted ctx exclusion, handle replay, streaming,
 * and inline "use cache" in handlers and layouts with handle data.
 */
export const useCachePatterns = urls(
  ({ path, layout, loading, intercept, loader, when }) => [
    // Basic: file-level "use cache", no args
    path(
      "/basic",
      async () => {
        const data = await getBasicTimestamp();
        return (
          <div data-testid="use-cache-basic-page">
            <h1>Basic Use Cache</h1>
            <span data-testid="use-cache-basic-ts">{data.ts}</span>
            <span data-testid="use-cache-basic-rand">{data.rand}</span>
          </div>
        );
      },
      { name: "useCacheTest.basic" },
    ),

    // With args: different categories produce different cache entries
    path(
      "/with-args/:category",
      async (ctx) => {
        const data = await getDataForCategory(ctx.params.category);
        return (
          <div data-testid="use-cache-args-page">
            <h1>Use Cache With Args</h1>
            <span data-testid="use-cache-args-category">{data.category}</span>
            <span data-testid="use-cache-args-ts">{data.ts}</span>
            <span data-testid="use-cache-args-rand">{data.rand}</span>
          </div>
        );
      },
      { name: "useCacheTest.withArgs" },
    ),

    // Named profile: "use cache: short"
    path(
      "/named-profile",
      async () => {
        const data = await getShortCachedData();
        return (
          <div data-testid="use-cache-profile-page">
            <h1>Named Profile Cache</h1>
            <span data-testid="use-cache-profile-ts">{data.ts}</span>
            <span data-testid="use-cache-profile-rand">{data.rand}</span>
          </div>
        );
      },
      { name: "useCacheTest.namedProfile" },
    ),

    // With handles: "use cache" function pushes breadcrumbs via tainted ctx.
    // Renders both a fresh server timestamp and the cached timestamp
    // so tests can prove the cached fn resolved from cache while handle
    // data was replayed from the cached entry.
    path(
      "/with-handles",
      async (ctx) => {
        const data = await fetchWithBreadcrumbs(ctx);
        const serverNow = Date.now();
        return (
          <div data-testid="use-cache-handles-page">
            <h1>Use Cache With Handles</h1>
            <span data-testid="use-cache-handles-ts">{data.ts}</span>
            <span data-testid="use-cache-handles-rand">{data.rand}</span>
            <span data-testid="use-cache-handles-server-ts">{serverNow}</span>
          </div>
        );
      },
      { name: "useCacheTest.withHandles" },
    ),

    // Streaming: slow cached data function rendered via loading() boundary.
    // Renders both a fresh server timestamp (uncached) and the cached timestamp
    // so tests can prove the cached value is stale while the server time is fresh.
    path(
      "/streaming",
      async () => {
        const data = await getSlowCachedData();
        const serverNow = Date.now();
        return (
          <div data-testid="use-cache-streaming-page">
            <h1>Streaming Cache Test</h1>
            <span data-testid="use-cache-streaming-ts">{data.ts}</span>
            <span data-testid="use-cache-streaming-rand">{data.rand}</span>
            <span data-testid="use-cache-streaming-server-ts">{serverNow}</span>
          </div>
        );
      },
      { name: "useCacheTest.streaming" },
      () => [
        loading(
          <div data-testid="use-cache-streaming-fallback">
            Loading slow content...
          </div>,
        ),
      ],
    ),

    // Cached React node: "use cache" function returns JSX, not plain data.
    // Internal await + streamed via loading() boundary.
    // Verifies RSC Flight serialization roundtrip works for React elements.
    path(
      "/cached-node",
      async () => {
        const node = await getCachedReactNode();
        const serverNow = Date.now();
        return (
          <div data-testid="use-cache-node-page">
            <h1>Cached React Node</h1>
            {node}
            <span data-testid="use-cache-node-server-ts">{serverNow}</span>
          </div>
        );
      },
      { name: "useCacheTest.cachedNode" },
      () => [
        loading(
          <div data-testid="use-cache-node-fallback">
            Loading cached node...
          </div>,
        ),
      ],
    ),

    // Inline "use cache" in path handler: the handler itself has the directive.
    // ctx is tainted and excluded from cache key. Breadcrumbs are pushed via
    // ctx.use(Breadcrumbs) and should be captured on miss, replayed on hit.
    path(
      "/inline-handler",
      async (ctx) => {
        "use cache";
        const pushBreadcrumb = ctx.use(Breadcrumbs);
        pushBreadcrumb({
          label: "Inline Cached Handler",
          href: "/use-cache-test/inline-handler",
        });
        return (
          <div data-testid="use-cache-inline-handler-page">
            <h1>Inline Handler Cache</h1>
            <span data-testid="inline-handler-ts">{Date.now()}</span>
            <span data-testid="inline-handler-rand">{Math.random()}</span>
          </div>
        );
      },
      { name: "useCacheTest.inlineHandler" },
    ),

    // Inline "use cache" on parameterized path: ctx.params must be included
    // in the cache key so different slugs produce different cache entries.
    path(
      "/inline-params/:slug",
      async (ctx) => {
        "use cache";
        return (
          <div data-testid="use-cache-inline-params-page">
            <span data-testid="inline-params-slug">{ctx.params.slug}</span>
            <span data-testid="inline-params-ts">{Date.now()}</span>
            <span data-testid="inline-params-rand">{Math.random()}</span>
          </div>
        );
      },
      { name: "useCacheTest.inlineParams" },
    ),

    // Inline "use cache" in layout handler: the layout itself has the directive.
    // ctx is tainted. Meta is set via ctx.use(Meta) — should be captured on
    // miss and replayed on hit so the page title is correct from cache.
    layout(
      async (ctx) => {
        "use cache";
        const meta = ctx.use(Meta);
        meta({ title: "Cached Layout Title" });
        return (
          <div data-testid="use-cache-inline-layout">
            <div data-testid="inline-layout-header">
              <span data-testid="inline-layout-ts">{Date.now()}</span>
            </div>
            <Outlet />
          </div>
        );
      },
      () => [
        path(
          "/inline-layout",
          () => (
            <div data-testid="use-cache-inline-layout-page">
              <h1>Inline Layout Child</h1>
              <span data-testid="inline-layout-child-ts">{Date.now()}</span>
            </div>
          ),
          { name: "useCacheTest.inlineLayout" },
        ),
      ],
    ),

    // Plain data: JSON endpoint using cached data function
    path.json(
      "/plain-data",
      async () => {
        const data = await getBasicTimestamp();
        return data;
      },
      { name: "useCacheTest.plainData" },
    ),

    // Branding: verify that "use cache" functions are branded at runtime.
    // getBasicTimestamp has file-level "use cache" so the Vite transform
    // wraps it with registerCachedFunction(), which stamps CACHED_FN_SYMBOL.
    path.json(
      "/brand-check",
      () => {
        return {
          cachedFnBranded: isCachedFunction(getBasicTimestamp),
          plainFnBranded: isCachedFunction(() => {}),
        };
      },
      { name: "useCacheTest.brandCheck" },
    ),

    // Loader: "use cache" function called inside a createLoader.
    // The loader runs on every request but the inner cached function
    // returns cached data on subsequent calls.
    path(
      "/with-loader",
      async (ctx) => {
        const data = await ctx.use(UseCacheTestLoader);
        const serverNow = Date.now();
        return (
          <div data-testid="use-cache-loader-page">
            <h1>Use Cache With Loader</h1>
            <span data-testid="use-cache-loader-ts">{data.ts}</span>
            <span data-testid="use-cache-loader-rand">{data.rand}</span>
            <span data-testid="use-cache-loader-server-ts">{serverNow}</span>
          </div>
        );
      },
      { name: "useCacheTest.withLoader" },
      () => [loader(UseCacheTestLoader)],
    ),

    // Intercept: inline "use cache" in path handler vs intercept handler.
    // The path and intercept handlers are different functions, so they get
    // different cache keys even though they render the same route.
    layout(
      () => (
        <div data-testid="use-cache-intercept-layout">
          <Outlet />
          <Outlet name="@useCacheModal" />
        </div>
      ),
      () => [
        path(
          "/intercept-index",
          () => (
            <div data-testid="use-cache-intercept-index">
              <h1>Intercept Cache Test</h1>
              <Link
                to="/use-cache-test/intercept-target/1"
                data-testid="use-cache-intercept-link"
              >
                Open modal for item 1
              </Link>
            </div>
          ),
          { name: "useCacheTest.interceptIndex" },
        ),

        // Path handler with inline "use cache" — renders a full page view.
        path(
          "/intercept-target/:id",
          async (ctx) => {
            "use cache";
            return (
              <div data-testid="use-cache-intercept-path-page">
                <h1>Full Page View</h1>
                <span data-testid="intercept-path-id">{ctx.params.id}</span>
                <span data-testid="intercept-path-ts">{Date.now()}</span>
                <span data-testid="intercept-path-rand">{Math.random()}</span>
              </div>
            );
          },
          { name: "useCacheTest.interceptTarget" },
        ),

        // Intercept handler with inline "use cache" — renders a modal view.
        // Different function = different cache key from the path handler.
        intercept(
          "@useCacheModal",
          ".useCacheTest.interceptTarget",
          async (ctx) => {
            "use cache";
            return (
              <div data-testid="use-cache-intercept-modal">
                <h2>Modal View</h2>
                <span data-testid="intercept-modal-id">{ctx.params.id}</span>
                <span data-testid="intercept-modal-ts">{Date.now()}</span>
                <span data-testid="intercept-modal-rand">{Math.random()}</span>
              </div>
            );
          },
          () => [
            when(({ from }) =>
              from.pathname.startsWith("/use-cache-test/intercept-"),
            ),
          ],
        ),
      ],
    ),

    // Interleave: compositional slots through "use cache" function.
    // header and children are ReactNode props -- they should pass through
    // the cache as temporary references. The cached function's own ts/rand
    // should be stable on cache hit, while slot content should be fresh.
    path(
      "/interleave-slots",
      async () => {
        const dynamicTs = Date.now();
        const node = await CachedWithSlots({
          header: (
            <h2 data-testid="interleave-slots-header-content">{dynamicTs}</h2>
          ),
          children: (
            <span data-testid="interleave-slots-children-content">
              {dynamicTs}
            </span>
          ),
        });
        const serverTs = Date.now();
        return (
          <div data-testid="interleave-slots-page">
            <h1>Interleave Slots Test</h1>
            {node}
            <span data-testid="interleave-slots-server-ts">{serverTs}</span>
          </div>
        );
      },
      { name: "useCacheTest.interleaveSlots" },
    ),

    // Interleave: server action works alongside cached data.
    // The cached function returns plain data; the client component (with
    // its own directly-imported action) is rendered next to the cached data.
    // Tests that actions work correctly when the route also uses "use cache".
    path(
      "/interleave-action",
      async () => {
        const data = await getCachedActionData();
        const serverTs = Date.now();
        return (
          <div data-testid="interleave-action-page">
            <h1>Interleave Action Test</h1>
            <span data-testid="cached-action-ts">{data.ts}</span>
            <span data-testid="cached-action-rand">{data.rand}</span>
            <InterleaveActionButton />
            <span data-testid="interleave-action-server-ts">{serverTs}</span>
          </div>
        );
      },
      { name: "useCacheTest.interleaveAction" },
    ),

    // path.json with "use cache" — responseType must be in cache key,
    // params must differentiate entries, response handler ctx must be tainted.
    path.json(
      "/json-cached/:id",
      async (ctx) => {
        "use cache";
        return { id: ctx.params.id, ts: Date.now(), rand: Math.random() };
      },
      { name: "useCacheTest.jsonCached" },
    ),
  ],
);
