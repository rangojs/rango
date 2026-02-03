import { urls } from "@rangojs/router";
import { Link } from "@rangojs/router/client";
import { HrefTestClient } from "../components/HrefTestClient.js";

/**
 * Href URL patterns for testing scoped href resolution
 * Tests both ctx.href (server-side) and useHref (client-side)
 */
export const hrefPatterns = urls(({ path, include }) => [
  // Index route - shows local href links
  path(
    "/",
    (ctx) => {
      // Server-side ctx.href tests
      const localIndexHref = ctx.href("index"); // Should resolve to /href (local)
      const localDetailHref = ctx.href("detail", { id: "123" }); // Should resolve to /href/123
      const absoluteBlogHref = ctx.href("blog.index"); // Should resolve to /blog (absolute)
      const pathBasedHref = ctx.href("/about"); // Should return /about (path-based)

      return (
        <div data-testid="href-index-page">
          <h1 data-testid="href-page-title">Href Test Page</h1>

          <section data-testid="server-href-section">
            <h2>Server-side ctx.href</h2>
            <ul>
              <li data-testid="server-local-index">
                Local index: <code>{localIndexHref}</code>
              </li>
              <li data-testid="server-local-detail">
                Local detail: <code>{localDetailHref}</code>
              </li>
              <li data-testid="server-absolute-blog">
                Absolute blog.index: <code>{absoluteBlogHref}</code>
              </li>
              <li data-testid="server-path-based">
                Path-based /about: <code>{pathBasedHref}</code>
              </li>
            </ul>

            <h3>Server-rendered Links</h3>
            <div data-testid="server-links">
              <Link to={localIndexHref} data-testid="server-link-local-index">
                Local Index Link
              </Link>
              {" | "}
              <Link to={localDetailHref} data-testid="server-link-local-detail">
                Local Detail Link
              </Link>
              {" | "}
              <Link to={absoluteBlogHref} data-testid="server-link-absolute-blog">
                Blog Link
              </Link>
            </div>
          </section>

          <section data-testid="client-href-section">
            <h2>Client-side useHref</h2>
            <HrefTestClient />
          </section>

          <section data-testid="navigation-section">
            <h2>Navigation Links</h2>
            <div>
              <Link to="/" data-testid="back-home-link">
                ← Back to Home
              </Link>
              {" | "}
              <Link to="/href/item-abc" data-testid="goto-detail-link">
                Go to Detail (item-abc)
              </Link>
              {" | "}
              <Link to="/href/nested" data-testid="goto-nested-link">
                Go to Nested
              </Link>
            </div>
          </section>
        </div>
      );
    },
    { name: "index" }
  ),

  // Nested module to test nested include resolution
  // IMPORTANT: Must come BEFORE /:id route, otherwise "nested" matches as an :id
  include("/nested", nestedHrefPatterns, { name: "nested" }),

  // Detail route with param (must be last since /:id matches anything)
  path(
    "/:id",
    (ctx) => {
      // Test ctx.href inside detail route
      const backToIndex = ctx.href("index");
      const siblingDetail = ctx.href("detail", { id: "sibling-item" });

      return (
        <div data-testid="href-detail-page">
          <h1 data-testid="detail-title">Detail: {ctx.params.id}</h1>

          <section data-testid="detail-server-href">
            <h2>Server-side ctx.href (from detail route)</h2>
            <ul>
              <li data-testid="detail-server-back-index">
                Back to index: <code>{backToIndex}</code>
              </li>
              <li data-testid="detail-server-sibling">
                Sibling detail: <code>{siblingDetail}</code>
              </li>
            </ul>
          </section>

          <section data-testid="detail-client-href">
            <h2>Client-side useHref (from detail route)</h2>
            <HrefTestClient isDetailPage />
          </section>

          <nav>
            <Link to={backToIndex} data-testid="detail-back-link">
              ← Back to Index
            </Link>
            {" | "}
            <Link to={siblingDetail} data-testid="detail-sibling-link">
              Go to Sibling
            </Link>
          </nav>
        </div>
      );
    },
    { name: "detail" }
  ),
]);

/**
 * Nested patterns to test nested include href resolution
 */
const nestedHrefPatterns = urls(({ path }) => [
  path(
    "/",
    (ctx) => {
      // From nested context, test href resolution
      const nestedIndex = ctx.href("index"); // Should resolve to /href/nested
      const parentIndex = ctx.href("href.index"); // Should resolve to /href (absolute)
      const parentDetail = ctx.href("href.detail", { id: "from-nested" }); // Should resolve to /href/from-nested

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
