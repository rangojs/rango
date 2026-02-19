import { Link } from "@rangojs/router/client";

interface ArticleWithUrl {
  slug: string;
  title: string;
  authorSlug: string;
  date: string;
  url: string;
  authorUrl?: string;
  authorName?: string;
}

interface AuthorWithUrl {
  slug: string;
  name: string;
  bio: string;
  url: string;
}

export function MagazineIndexPage({
  articles,
  authors,
}: {
  articles: ArticleWithUrl[];
  authors: AuthorWithUrl[];
}) {
  return (
    <div data-testid="magazine-index">
      <h2>Articles</h2>
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
              style={{ color: "#3b82f6", textDecoration: "none", fontWeight: 500, fontSize: "1.1rem" }}
            >
              {article.title}
            </Link>
            {article.authorUrl && article.authorName && (
              <div style={{ color: "#666", fontSize: "0.85rem", marginTop: "0.25rem" }}>
                by{" "}
                <Link
                  to={article.authorUrl}
                  style={{ color: "#3b82f6", textDecoration: "none" }}
                >
                  {article.authorName}
                </Link>
                {" - "}
                {article.date}
              </div>
            )}
          </li>
        ))}
      </ul>

      <h2>Authors</h2>
      <ul style={{ listStyle: "none", padding: 0 }}>
        {authors.map((author) => (
          <li key={author.slug} style={{ marginBottom: "0.5rem" }}>
            <Link
              to={author.url}
              style={{ color: "#3b82f6", textDecoration: "none" }}
            >
              {author.name}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
