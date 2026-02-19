import { Link } from "@rangojs/router/client";
import type { MagazineArticle, MagazineAuthor } from "../data/mock-data.js";

export function MagazineArticlePage({
  article,
  author,
  authorUrl,
  indexUrl,
}: {
  article: MagazineArticle;
  author: MagazineAuthor | undefined;
  authorUrl?: string;
  indexUrl: string;
}) {
  return (
    <div data-testid="magazine-article">
      <h2>{article.title}</h2>
      <div style={{ color: "#666", fontSize: "0.85rem", marginBottom: "1rem" }}>
        {article.date}
        {author && authorUrl && (
          <>
            {" - "}
            by{" "}
            <Link
              to={authorUrl}
              style={{ color: "#3b82f6", textDecoration: "none" }}
            >
              {author.name}
            </Link>
          </>
        )}
      </div>
      <p style={{ color: "#475569", lineHeight: 1.6 }}>
        This is the content of the article "{article.title}". In a real application, this would
        contain the full article text.
      </p>
      <p style={{ marginTop: "1rem" }}>
        <Link to={indexUrl} style={{ color: "#0066cc", textDecoration: "none" }}>
          Back to magazine
        </Link>
      </p>
    </div>
  );
}
