import { Static, Prerender, scopedReverse } from "@rangojs/router";
import { Outlet } from "@rangojs/router/client";
import type { routes } from "./urls.gen.js";

interface RefDoc {
  slug: string;
  title: string;
  excerpt: string;
  content: string;
}

// Dynamic import keeps node:fs out of the production bundle.
// After build-time rendering the handler is evicted, so node:fs
// never reaches workerd.
async function readReferenceData(): Promise<RefDoc[]> {
  try {
    const { readFileSync } = await import("node:fs");
    const { resolve, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const __dirname = dirname(fileURLToPath(import.meta.url));
    return JSON.parse(
      readFileSync(resolve(__dirname, "../data/reference.json"), "utf-8"),
    );
  } catch {
    // Fallback when node:fs is unavailable (workerd dev mode).
    return [
      {
        slug: "url-patterns",
        title: "URL Patterns API",
        excerpt: "Define routes with the urls() builder function.",
        content:
          "The urls() function accepts a builder callback that receives helpers like path, layout, include, and parallel.",
      },
      {
        slug: "response-types",
        title: "Response Types",
        excerpt: "Return JSON, text, markdown, and other formats from routes.",
        content: "Response routes skip the RSC pipeline and return raw data.",
      },
    ];
  }
}

const BUILD_TIMESTAMP = new Date().toISOString();

// Static layout: rendered once at build time, provides sidebar navigation.
// Uses node:fs to read package-local reference data and ctx.reverse for links.
export const DocsLayout = Static(async (ctx) => {
  const reverse = scopedReverse<routes>(ctx.reverse);
  const docs = await readReferenceData();
  return (
    <div data-testid="docs-layout" style={{ display: "flex", gap: "2rem" }}>
      <aside
        data-testid="docs-sidebar"
        style={{ width: "220px", flexShrink: 0 }}
      >
        <h3>Reference</h3>
        <ul style={{ listStyle: "none", padding: 0 }}>
          {docs.map((doc) => (
            <li
              key={doc.slug}
              data-testid={`sidebar-item-${doc.slug}`}
              style={{ marginBottom: "0.5rem" }}
            >
              <a
                href={reverse(".refDetail", { slug: doc.slug })}
                style={{ color: "#0070f3", textDecoration: "none" }}
                data-testid={`sidebar-link-${doc.slug}`}
              >
                {doc.title}
              </a>
            </li>
          ))}
        </ul>
        <p
          data-testid="sidebar-build-time"
          style={{ fontSize: "0.75rem", color: "#999" }}
        >
          Sidebar built at: {BUILD_TIMESTAMP}
        </p>
      </aside>
      <div style={{ flex: 1 }}>
        <Outlet />
      </div>
    </div>
  );
});

// Prerender index: lists all reference docs, rendered at build time.
// Uses ctx.reverse for navigation links.
export const RefIndex = Prerender(async (ctx) => {
  const reverse = scopedReverse<routes>(ctx.reverse);
  const docs = await readReferenceData();
  return (
    <div data-testid="ref-index">
      <h1 data-testid="ref-title">API Reference</h1>
      <p style={{ color: "#666", marginBottom: "1.5rem" }}>
        Pre-rendered from package-local data at build time.
      </p>
      <ul data-testid="ref-list" style={{ listStyle: "none", padding: 0 }}>
        {docs.map((doc) => (
          <li
            key={doc.slug}
            data-testid={`ref-item-${doc.slug}`}
            style={{ marginBottom: "1rem" }}
          >
            <h2 style={{ marginBottom: "0.25rem" }}>
              <a
                href={reverse(".refDetail", { slug: doc.slug })}
                style={{ color: "#0070f3", textDecoration: "none" }}
                data-testid={`ref-link-${doc.slug}`}
              >
                {doc.title}
              </a>
            </h2>
            <p style={{ color: "#666", margin: 0 }}>{doc.excerpt}</p>
          </li>
        ))}
      </ul>
      <p
        data-testid="ref-build-time"
        style={{ fontSize: "0.75rem", color: "#999" }}
      >
        Built at: {BUILD_TIMESTAMP}
      </p>
    </div>
  );
});

// Prerender detail: renders individual reference doc, one per slug at build time.
export const RefDetail = Prerender(
  async () => {
    const docs = await readReferenceData();
    return docs.map((d) => ({ slug: d.slug }));
  },
  async (ctx) => {
    const reverse = scopedReverse<routes>(ctx.reverse);
    const docs = await readReferenceData();
    const doc = docs.find((d) => d.slug === ctx.params.slug);

    if (!doc) {
      return (
        <div data-testid="ref-not-found">
          <h1>Reference Not Found</h1>
          <p>No reference doc with slug &ldquo;{ctx.params.slug}&rdquo;.</p>
        </div>
      );
    }

    return (
      <article data-testid="ref-detail">
        <nav style={{ marginBottom: "1rem" }}>
          <a
            href={reverse(".refIndex")}
            style={{ color: "#0070f3", textDecoration: "none" }}
            data-testid="ref-back-link"
          >
            &larr; Back to Reference
          </a>
        </nav>
        <h1 data-testid="ref-detail-title">{doc.title}</h1>
        <p style={{ color: "#666", marginBottom: "1.5rem" }}>{doc.excerpt}</p>
        <div
          data-testid="ref-detail-content"
          style={{ lineHeight: 1.7, whiteSpace: "pre-wrap" }}
        >
          {doc.content}
        </div>
        <p
          data-testid="ref-detail-build-time"
          style={{ fontSize: "0.75rem", color: "#999" }}
        >
          Built at: {BUILD_TIMESTAMP}
        </p>
      </article>
    );
  },
);
