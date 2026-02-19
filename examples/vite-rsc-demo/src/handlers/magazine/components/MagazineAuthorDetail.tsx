import { Link } from "@rangojs/router/client";
import type { MagazineAuthor } from "../data/mock-data.js";

interface ArticleWithUrl {
  slug: string;
  title: string;
  authorSlug: string;
  date: string;
  url: string;
}

export function MagazineAuthorDetail({
  author,
  articles,
  authorPostsUrl,
  indexUrl,
}: {
  author: MagazineAuthor;
  articles: ArticleWithUrl[];
  authorPostsUrl: string;
  indexUrl: string;
}) {
  return (
    <div data-testid="magazine-author">
      <h2>{author.name}</h2>
      <p style={{ color: "#475569", lineHeight: 1.6 }}>{author.bio}</p>

      <h3>Articles ({articles.length})</h3>
      <ul style={{ listStyle: "none", padding: 0 }}>
        {articles.map((article) => (
          <li key={article.slug} style={{ marginBottom: "0.75rem" }}>
            <Link
              to={article.url}
              style={{ color: "#3b82f6", textDecoration: "none", fontWeight: 500 }}
            >
              {article.title}
            </Link>
            <span style={{ color: "#94a3b8", fontSize: "0.8rem", marginLeft: "0.5rem" }}>
              {article.date}
            </span>
          </li>
        ))}
      </ul>

      <p>
        <Link
          to={authorPostsUrl}
          style={{ color: "#3b82f6" }}
        >
          View all articles by {author.name}
        </Link>
      </p>

      <p style={{ marginTop: "1rem" }}>
        <Link to={indexUrl} style={{ color: "#0066cc", textDecoration: "none" }}>
          Back to magazine
        </Link>
      </p>
    </div>
  );
}
