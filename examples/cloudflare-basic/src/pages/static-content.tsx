import { createStaticHandler } from "@rangojs/router";
import { Link, Outlet } from "@rangojs/router/client";
import { reverse } from "../router.js";

// Build-time data: simulates reading a docs nav structure.
// In a real app this could be readFileSync, a database call, etc.
const docsNavItems = [
  { label: "Getting Started", slug: "getting-started" },
  { label: "Configuration", slug: "configuration" },
  { label: "Deployment", slug: "deployment" },
];

// Build-time unique marker to verify the handler ran at build time
// and is NOT re-executing at runtime (timestamp would differ)
const BUILD_TIMESTAMP = new Date().toISOString();

// --- Static layout: rendered once at build time, wraps child routes. ---
// The nav never changes, so there's no reason to re-render it per request.
export const DocsNavLayout = createStaticHandler(() => {
  return (
    <div data-testid="static-docs-layout">
      <nav data-testid="static-docs-nav">
        <h3>Docs Navigation</h3>
        <ul>
          {docsNavItems.map((item) => (
            <li key={item.slug}>
              <Link
                to={reverse("staticContent.docsPage", { slug: item.slug })}
                data-testid={`docs-nav-${item.slug}`}
              >
                {item.label}
              </Link>
            </li>
          ))}
        </ul>
        <p data-testid="static-nav-build-time" style={{ fontSize: "0.75rem", color: "#999" }}>
          Nav built at: {BUILD_TIMESTAMP}
        </p>
      </nav>
      <div data-testid="static-docs-content">
        <Outlet />
      </div>
    </div>
  );
});

// --- Static path: rendered once at build time on a path() route. ---
// The index page content is fixed.
export const DocsIndexPage = createStaticHandler(() => {
  return (
    <div data-testid="static-docs-index">
      <h1>Documentation</h1>
      <p data-testid="static-index-info">
        Welcome to the docs. This index page is statically rendered at build
        time.
      </p>
      <p data-testid="static-index-build-time" style={{ fontSize: "0.75rem", color: "#999" }}>
        Index built at: {BUILD_TIMESTAMP}
      </p>
      <ul data-testid="static-docs-list">
        {docsNavItems.map((item) => (
          <li key={item.slug}>
            <Link
              to={reverse("staticContent.docsPage", { slug: item.slug })}
              data-testid={`docs-index-link-${item.slug}`}
            >
              {item.label}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
});

// --- Static parallel slot: rendered once at build time in a @sidebar slot. ---
// Provides a table of contents that doesn't change between requests.
export const DocsTocSidebar = createStaticHandler(() => {
  return (
    <aside data-testid="static-toc-sidebar">
      <h4>Table of Contents</h4>
      <ol data-testid="static-toc-list">
        {docsNavItems.map((item, i) => (
          <li key={item.slug} data-testid={`toc-item-${item.slug}`}>
            {i + 1}. {item.label}
          </li>
        ))}
      </ol>
      <p data-testid="static-toc-build-time" style={{ fontSize: "0.75rem", color: "#999" }}>
        TOC built at: {BUILD_TIMESTAMP}
      </p>
    </aside>
  );
});
