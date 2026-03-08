import { urls } from "@rangojs/router";
import { Outlet, Link } from "@rangojs/router/client";
import {
  HrefIndexHandler,
  HrefDetailHandler,
  HrefFilteredHandler,
} from "./href.handlers.js";
import { MountedParallelClient } from "../components/MountedParallelClient.js";

/**
 * Href URL patterns for testing scoped href resolution
 * Tests ctx.reverse (server-side) and href()+useMount() (client-side)
 *
 * Wrapped in a layout so the @sidebar parallel slot can render alongside routes.
 * The layout also tests that useMount/useHref inside a mounted parallel slot
 * sees the correct include() mount path.
 */
export const hrefPatterns = urls(({ path, include, layout, parallel }) => [
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

      // Detail route with param (must be last since /:id matches anything)
      path("/:id", HrefDetailHandler, { name: "detail" }),

      // Parallel slot to test useMount/useHref inside a mounted parallel
      parallel({ "@sidebar": () => <MountedParallelClient /> }),
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
