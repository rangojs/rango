import { Link } from "@rangojs/router/client";
import type { DocArticle } from "../index.js";

export function DocsArticle({
  article,
  slug,
  reverse,
}: {
  article: DocArticle | null;
  slug: string;
  reverse: (name: string, params?: Record<string, string>) => string;
}) {
  if (!article) {
    return (
      <div data-testid="docs-not-found">
        <h1>Not Found</h1>
        <p>No article with slug &ldquo;{slug}&rdquo;.</p>
        <Link to={reverse(".index")} style={{ color: "#0070f3" }}>
          &larr; Back to Docs
        </Link>
      </div>
    );
  }

  return (
    <article data-testid="docs-detail">
      <nav
        style={{
          marginBottom: "1rem",
          paddingBottom: "0.5rem",
          borderBottom: "1px solid #eee",
          display: "flex",
          gap: "1rem",
        }}
      >
        <Link
          to={reverse(".index")}
          style={{ color: "#0070f3", textDecoration: "none" }}
          data-testid="docs-back-link"
        >
          &larr; Back to Docs
        </Link>
        <a
          href={reverse(".raw", { slug: article.slug })}
          style={{ color: "#666", textDecoration: "none", fontSize: "0.875rem" }}
          data-testid="docs-raw-link"
        >
          View Raw Markdown
        </a>
      </nav>
      <h1 data-testid="docs-detail-title">{article.title}</h1>
      <p style={{ color: "#666", marginBottom: "1.5rem" }}>{article.excerpt}</p>
      <div data-testid="docs-detail-content" style={{ lineHeight: 1.7, whiteSpace: "pre-wrap" }}>
        {article.content}
      </div>
    </article>
  );
}
