import { urls } from "@rangojs/router";
import { Link } from "@rangojs/router/client";
import { HrefIndexHandler, HrefDetailHandler } from "./href.handlers.js";

/**
 * Href URL patterns for testing scoped href resolution
 * Tests ctx.href (server-side) and href()+useMount() (client-side)
 */
export const hrefPatterns = urls(({ path, include }) => [
  path("/", HrefIndexHandler, { name: "index" }),

  // Nested module to test nested include resolution
  // IMPORTANT: Must come BEFORE /:id route, otherwise "nested" matches as an :id
  include("/nested", nestedHrefPatterns, { name: "nested" }),

  // Detail route with param (must be last since /:id matches anything)
  path("/:id", HrefDetailHandler, { name: "detail" }),
]);

/**
 * Nested patterns to test nested include href resolution
 */
const nestedHrefPatterns = urls(({ path }) => [
  path(
    "/",
    (ctx) => {
      // From nested context, test href resolution
      // Using absolute names for type safety
      const nestedIndex = ctx.href("href.nested.index"); // Absolute name for /href/nested
      const parentIndex = ctx.href("href.index"); // Absolute name for /href
      const parentDetail = ctx.href("href.detail", { id: "from-nested" }); // Absolute name for /href/from-nested

      return (
        <div data-testid="href-nested-page">
          <h1 data-testid="nested-title">Nested Href Test</h1>

          <section data-testid="nested-server-href">
            <h2>Server-side ctx.href (from nested route)</h2>
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
    { name: "index" }
  ),
]);
