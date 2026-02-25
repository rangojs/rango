import { Link } from "@rangojs/router/client";
import type { MagazineAuthor } from "../data/mock-data.js";

interface ArticleWithUrl {
  slug: string;
  title: string;
  authorSlug: string;
  date: string;
  url: string;
}

export function MagazineAuthorPostsPage({
  author,
  articles,
  authorUrl,
  indexUrl,
}: {
  author: MagazineAuthor;
  articles: ArticleWithUrl[];
  authorUrl: string;
  indexUrl: string;
}) {
  return (
    <div data-testid="magazine-author-posts">
      <h2>Articles by {author.name}</h2>

      <ul style={{ listStyle: "none", padding: 0 }}>
        {articles.map((article) => (
          <li
            key={article.slug}
            style={{
              marginBottom: "1rem",
              padding: "0.75rem",
              background: "#f8f9fa",
              borderRadius: "6px",
            }}
          >
            <Link
              to={article.url}
              style={{
                color: "#3b82f6",
                textDecoration: "none",
                fontWeight: 500,
                fontSize: "1.1rem",
              }}
            >
              {article.title}
            </Link>
            <div
              style={{
                color: "#94a3b8",
                fontSize: "0.8rem",
                marginTop: "0.25rem",
              }}
            >
              {article.date}
            </div>
          </li>
        ))}
      </ul>

      <p>
        <Link
          to={authorUrl}
          style={{ color: "#0066cc", textDecoration: "none" }}
        >
          Back to {author.name}
        </Link>
        {" | "}
        <Link
          to={indexUrl}
          style={{ color: "#0066cc", textDecoration: "none" }}
        >
          Back to magazine
        </Link>
      </p>
    </div>
  );
}
