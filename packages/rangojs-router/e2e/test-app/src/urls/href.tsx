import { urls } from "@rangojs/router";
import { Outlet, Link } from "@rangojs/router/client";
import {
  HrefIndexHandler,
  HrefDetailHandler,
  HrefFilteredHandler,
} from "./href.handlers.js";
import { MountedParallelClient } from "../components/MountedParallelClient.js";
import { NullHandlerChild } from "./null-handler.js";

/**
 * Href URL patterns for testing scoped href resolution
 * Tests ctx.reverse (server-side) and href()+useMount() (client-side)
 *
 * Wrapped in a layout so the @sidebar parallel slot can render alongside routes.
 * The layout also tests that useMount/useHref inside a mounted parallel slot
 * sees the correct include() mount path.
 */
export const hrefPatterns = urls(
  ({ path, include, layout, parallel, cache }) => [
    layout(
      () => (
        <div data-testid="href-layout">
          <Outlet />
          <Outlet name="@sidebar" />
        </div>
      ),
      () => [
        path("/", HrefIndexHandler, { name: "index" }),

        // Nested module to test nested include resolution
        // IMPORTANT: Must come BEFORE /:id route, otherwise "nested" matches as an :id
        include("/nested", nestedHrefPatterns, { name: "nested" }),

        // Filtered route with params + search schema (for Handler<".name", routes> type test)
        path("/filtered/:category", HrefFilteredHandler, {
          name: "filtered",
          search: { q: "string", page: "number?", active: "boolean?" },
        }),

        // Null handler regression test: handler returns null but has child layout + parallel.
        // The route segment must appear in the partial diff even with null component,
        // otherwise the client errors with "Missing segment" on SPA navigation.
        include("/null-handler", nullHandlerPatterns, {
          name: "nullHandler",
        }),

        // Null handler + cache() DSL
        include("/null-handler-cached", nullHandlerCachedPatterns, {
          name: "nullHandlerCached",
        }),

        // Null handler + inline "use cache"
        include("/null-handler-use-cache", nullHandlerUseCachePatterns, {
          name: "nullHandlerUseCache",
        }),

        // Detail route with param (must be last since /:id matches anything)
        path("/:id", HrefDetailHandler, { name: "detail" }),

        // Parallel slot to test useMount/useHref inside a mounted parallel
        parallel({ "@sidebar": () => <MountedParallelClient /> }),
      ],
    ),
  ],
);

/**
 * Null handler patterns: handler returns null but has child layout + parallel.
 * Regression test for partial diff omitting structurally required segments.
 */
const nullHandlerPatterns = urls(({ path, layout, parallel }) => [
  path(
    "/",
    (ctx: any) => {
      ctx.set("null-handler-marker", "from-null-handler");
      return null;
    },
    { name: "index" },
    () => [
      layout(
        (ctx: any) => (
          <div data-testid="null-handler-layout">
            <span data-testid="null-handler-marker">
              {ctx.get("null-handler-marker") ?? "missing"}
            </span>
            <Outlet />
            <Outlet name="@nh-slot" />
          </div>
        ),
        () => [parallel({ "@nh-slot": () => <NullHandlerChild /> })],
      ),
    ],
  ),
]);

/**
 * Null handler + cache() DSL variant.
 */
const nullHandlerCachedPatterns = urls(({ path, layout, parallel, cache }) => [
  cache({ ttl: 600 }, () => [
    path(
      "/",
      (ctx: any) => {
        ctx.set("null-handler-marker", "from-cached-null-handler");
        return null;
      },
      { name: "index" },
      () => [
        layout(
          (ctx: any) => (
            <div data-testid="null-handler-cached-layout">
              <span data-testid="null-handler-cached-marker">
                {ctx.get("null-handler-marker") ?? "missing"}
              </span>
              <Outlet />
              <Outlet name="@nhc-slot" />
            </div>
          ),
          () => [parallel({ "@nhc-slot": () => <NullHandlerChild cached /> })],
        ),
      ],
    ),
  ]),
]);

/**
 * Null handler + inline "use cache" variant.
 * ctx.set() is not allowed inside "use cache", so the handler just returns null.
 */
const nullHandlerUseCachePatterns = urls(({ path, layout, parallel }) => [
  path(
    "/",
    async () => {
      "use cache";
      return null;
    },
    { name: "index" },
    () => [
      layout(
        () => (
          <div data-testid="null-handler-use-cache-layout">
            <Outlet />
            <Outlet name="@nhuc-slot" />
          </div>
        ),
        () => [parallel({ "@nhuc-slot": () => <NullHandlerChild useCache /> })],
      ),
    ],
  ),
]);

/**
 * Nested patterns to test nested include href resolution
 */
const nestedHrefPatterns = urls(({ path }) => [
  path(
    "/",
    (ctx) => {
      // From nested context, test reverse resolution
      // Using absolute names for type safety
      const nestedIndex = ctx.reverse("href.nested.index"); // Absolute name for /href/nested
      const parentIndex = ctx.reverse("href.index"); // Absolute name for /href
      const parentDetail = ctx.reverse("href.detail", { id: "from-nested" }); // Absolute name for /href/from-nested

      return (
        <div data-testid="href-nested-page">
          <h1 data-testid="nested-title">Nested Href Test</h1>

          <section data-testid="nested-server-href">
            <h2>Server-side ctx.reverse (from nested route)</h2>
            <ul>
              <li data-testid="nested-server-local-index">
                Local index: <code>{nestedIndex}</code>
              </li>
              <li data-testid="nested-server-parent-index">
                Parent href.index: <code>{parentIndex}</code>
              </li>
              <li data-testid="nested-server-parent-detail">
                Parent href.detail: <code>{parentDetail}</code>
              </li>
            </ul>
          </section>

          <nav>
            <Link to={parentIndex} data-testid="nested-back-parent-link">
              ← Back to Parent Index
            </Link>
            {" | "}
            <Link to={parentDetail} data-testid="nested-to-parent-detail-link">
              Go to Parent Detail
            </Link>
          </nav>
        </div>
      );
    },
    { name: "index" },
  ),
]);
