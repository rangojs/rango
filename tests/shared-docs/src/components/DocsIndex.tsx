import { Link } from "@rangojs/router/client";
import type { DocArticle } from "../index.js";

export function DocsIndex({
  articles,
  reverse,
}: {
  articles: DocArticle[];
  reverse: (name: string, params?: Record<string, string>) => string;
}) {
  return (
    <div data-testid="docs-index">
      <h1 data-testid="docs-title">Documentation</h1>
      <p style={{ color: "#666", marginBottom: "2rem" }}>
        Browse {articles.length} articles.
      </p>
      <ul data-testid="docs-list" style={{ listStyle: "none", padding: 0 }}>
        {articles.map((article) => (
          <li
            key={article.slug}
            data-testid={`docs-item-${article.slug}`}
            style={{
              marginBottom: "1.5rem",
              paddingBottom: "1rem",
              borderBottom: "1px solid #eee",
            }}
          >
            <h2 style={{ marginBottom: "0.25rem" }}>
              <Link
                to={reverse(".detail", { slug: article.slug })}
                style={{ color: "#0070f3", textDecoration: "none" }}
                data-testid={`docs-link-${article.slug}`}
              >
                {article.title}
              </Link>
            </h2>
            <p style={{ color: "#666", margin: 0 }}>{article.excerpt}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}
