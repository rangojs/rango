import { urls, Meta } from "@rangojs/router";
import { Outlet } from "@rangojs/router/client";
import {
  getBasicTimestamp,
  getDataForCategory,
} from "./use-cache-data.js";
import {
  getShortCachedData,
  fetchWithBreadcrumbs,
  getSlowCachedData,
  getCachedReactNode,
} from "./use-cache-fn.js";
import { Breadcrumbs } from "../handles.js";

/**
 * "use cache" test routes.
 *
 * Tests file-level and function-level "use cache" directives,
 * named profiles, tainted ctx exclusion, handle replay, streaming,
 * and inline "use cache" in handlers and layouts with handle data.
 */
export const useCachePatterns = urls(
  ({ path, layout, loading }) => [
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
  ],
);
