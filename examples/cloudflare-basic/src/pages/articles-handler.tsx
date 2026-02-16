import { Meta, Prerender } from "@rangojs/router";
import { Link, ParallelOutlet } from "@rangojs/router/client";
import { Breadcrumbs } from "../handles/breadcrumbs.js";
import { reverse } from "../router.js";

interface Article {
  slug: string;
  title: string;
  excerpt: string;
  author: string;
  publishedAt: string;
  content: string;
}

// Read all .md files from content/articles/ at build time via Vite's glob import.
// The ?raw query returns file contents as strings — no Node.js fs APIs needed.
const mdFiles = import.meta.glob("../../content/articles/*.md", {
  query: "?raw",
  eager: true,
}) as Record<string, { default: string }>;

function parseFrontmatter(raw: string): {
  meta: Record<string, string>;
  content: string;
} {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { meta: {}, content: raw };

  const meta: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    meta[key] = value;
  }
  return { meta, content: match[2].trim() };
}

const articles: Article[] = Object.entries(mdFiles).map(([filePath, mod]) => {
  const slug = filePath.split("/").pop()!.replace(".md", "");
  const { meta, content } = parseFrontmatter(mod.default);
  return {
    slug,
    title: meta.title ?? slug,
    excerpt: meta.excerpt ?? "",
    author: meta.author ?? "Unknown",
    publishedAt: meta.publishedAt ?? "",
    content,
  };
});

// Article list
export const ArticlesIndex = Prerender(async (ctx) => {
  const meta = ctx.use(Meta);
  meta({ title: "Articles - RSC Router Cloudflare" });
  meta({
    name: "description",
    content: "Articles about pre-rendering, caching, and RSC patterns",
  });

  const breadcrumb = ctx.use(Breadcrumbs);
  breadcrumb({ label: "Home", href: reverse("home") });
  breadcrumb({ label: "Articles", href: reverse("articles.index") });

  return (
    <div data-testid="articles-index" style={{ display: "flex", gap: "2rem" }}>
      <div style={{ flex: 1 }}>
        <h1 data-testid="articles-title">Articles</h1>
        <p style={{ color: "#666", marginBottom: "2rem" }}>
          Pre-rendered articles about RSC patterns and techniques.
        </p>
        <div data-testid="articles-list">
          {articles.map((article) => (
            <article
              key={article.slug}
              style={{
                marginBottom: "2rem",
                paddingBottom: "1.5rem",
                borderBottom: "1px solid #eee",
              }}
              data-testid={`article-card-${article.slug}`}
            >
              <h2 style={{ marginBottom: "0.5rem" }}>
                <Link
                  to={reverse("articles.detail", { slug: article.slug })}
                  style={{ color: "#0070f3", textDecoration: "none" }}
                  data-testid={`article-link-${article.slug}`}
                >
                  {article.title}
                </Link>
              </h2>
              <p
                style={{
                  color: "#666",
                  fontSize: "0.875rem",
                  marginBottom: "0.5rem",
                }}
              >
                By {article.author} on {article.publishedAt}
              </p>
              <p>{article.excerpt}</p>
            </article>
          ))}
        </div>
        <p
          data-testid="prerender-info"
          style={{ marginTop: "2rem", fontSize: "0.875rem", color: "#999" }}
        >
          This page is pre-rendered at build time from {articles.length} articles.
        </p>
      </div>
      <aside style={{ width: "280px", flexShrink: 0 }}>
        <ParallelOutlet name="@stats" />
      </aside>
    </div>
  );
});

// Article detail -- derives params from discovered .md files
export const ArticleDetail = Prerender(
  async () => articles.map((a) => ({ slug: a.slug })),
  async (ctx) => {
    const article = articles.find((a) => a.slug === ctx.params.slug);

    if (!article) {
      return (
        <div data-testid="article-not-found">
          <h1>Article Not Found</h1>
          <p>No article with slug &ldquo;{ctx.params.slug}&rdquo;.</p>
        </div>
      );
    }

    const meta = ctx.use(Meta);
    meta({ title: `${article.title} - Articles - RSC Router` });
    meta({ name: "description", content: article.excerpt });

    const breadcrumb = ctx.use(Breadcrumbs);
    breadcrumb({ label: "Home", href: reverse("home") });
    breadcrumb({ label: "Articles", href: reverse("articles.index") });
    breadcrumb({
      label: article.title,
      href: reverse("articles.detail", { slug: article.slug }),
    });

    return (
      <article data-testid="article-detail">
        <nav
          style={{
            marginBottom: "1rem",
            paddingBottom: "0.5rem",
            borderBottom: "1px solid #eee",
          }}
        >
          <Link
            to={reverse("articles.index")}
            style={{ color: "#0070f3", textDecoration: "none" }}
          >
            &larr; Back to Articles
          </Link>
        </nav>
        <header style={{ marginBottom: "2rem" }}>
          <h1 data-testid="article-title">{article.title}</h1>
          <p style={{ color: "#666", fontSize: "0.875rem" }}>
            By <span data-testid="article-author">{article.author}</span> on{" "}
            <span data-testid="article-date">{article.publishedAt}</span>
          </p>
        </header>
        <div
          data-testid="article-content"
          style={{ lineHeight: 1.7, whiteSpace: "pre-wrap" }}
        >
          {article.content}
        </div>
        <footer
          data-testid="prerender-info"
          style={{
            marginTop: "3rem",
            paddingTop: "1rem",
            borderTop: "1px solid #eee",
            fontSize: "0.875rem",
            color: "#999",
          }}
        >
          This page is pre-rendered at build time.
        </footer>
      </article>
    );
  }
);
