import { createStaticHandler } from "@rangojs/router";
import { Link, Outlet } from "@rangojs/router/client";
import { reverse } from "../router.js";

interface NavItem {
  label: string;
  slug: string;
}

// Read docs nav data at build time via node:fs (dynamic import).
// Dynamic import ensures node:fs is not in the module scope and doesn't
// crash workerd at runtime. The whole-file stub replacement drops
// everything for client/SSR bundles.
//
// In Cloudflare dev mode, static handlers are intercepted by the
// cache-lookup middleware and resolved via the prerender endpoint
// (Node.js), so this function runs in Node.js — not workerd.
// The try/catch remains for production Cloudflare where handlers still
// run in workerd until build-time rendering + eviction is implemented.
async function readDocsNavItems(): Promise<NavItem[]> {
  try {
    const { readFileSync } = await import("node:fs");
    const { resolve, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const __dirname = dirname(fileURLToPath(import.meta.url));
    return JSON.parse(
      readFileSync(resolve(__dirname, "../../content/docs-nav.json"), "utf-8"),
    );
  } catch {
    // Dev mode fallback: workerd can't access host filesystem.
    // Must match content/docs-nav.json.
    return [
      { label: "Getting Started", slug: "getting-started" },
      { label: "Configuration", slug: "configuration" },
      { label: "Deployment", slug: "deployment" },
    ];
  }
}

// Build-time unique marker to verify the handler ran at build time
// and is NOT re-executing at runtime (timestamp would differ)
const BUILD_TIMESTAMP = new Date().toISOString();

// --- Static layout: rendered once at build time, wraps child routes. ---
// The nav never changes, so there's no reason to re-render it per request.
export const DocsNavLayout = createStaticHandler(async () => {
  const docsNavItems = await readDocsNavItems();
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
export const DocsIndexPage = createStaticHandler(async () => {
  const docsNavItems = await readDocsNavItems();
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
export const DocsTocSidebar = createStaticHandler(async () => {
  const docsNavItems = await readDocsNavItems();
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
