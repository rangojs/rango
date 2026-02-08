import { Meta, createPrerenderHandler, urls } from "@rangojs/router";
import { Link } from "@rangojs/router/client";
import { Breadcrumbs } from "../handles/breadcrumbs.js";
import { href } from "../router.js";

// -- Markdown reading (build-time only, not available on Cloudflare Workers) --
//
// All Node.js fs/path usage is inside async functions called from the prerender
// handlers. In phase 2 these handlers won't run in the production worker at all
// (the build pipeline will serve stored Flight payloads). In phase 1 (dev mode)
// the handlers run on-demand in Node.js where these APIs are available.

interface Article {
  slug: string;
  title: string;
  excerpt: string;
  author: string;
  publishedAt: string;
  content: string;
}

/**
 * Parse simple YAML frontmatter from a markdown string.
 * Handles --- delimited frontmatter with key: value pairs.
 */
function parseFrontmatter(raw: string): { meta: Record<string, string>; content: string } {
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

/**
 * Read all article markdown files from the content directory.
 * Uses dynamic imports for node:fs and node:path so the top-level module
 * can load in environments without Node.js built-ins (e.g. workerd).
 */
async function readAllArticles(): Promise<Article[]> {
  const { readFileSync, readdirSync } = await import("node:fs");
  const { join, resolve } = await import("node:path");
  const contentDir = resolve(import.meta.dirname, "../../content/articles");

  const files = readdirSync(contentDir).filter((f) => f.endsWith(".md")).sort();
  return files.map((filename) => {
    const slug = filename.replace(/\.md$/, "");
    const raw = readFileSync(join(contentDir, filename), "utf-8");
    const { meta, content } = parseFrontmatter(raw);
    return {
      slug,
      title: meta.title ?? slug,
      excerpt: meta.excerpt ?? "",
      author: meta.author ?? "Unknown",
      publishedAt: meta.publishedAt ?? "",
      content,
    };
  });
}

async function readArticle(slug: string): Promise<Article | null> {
  const { readFileSync } = await import("node:fs");
  const { join, resolve } = await import("node:path");
  const contentDir = resolve(import.meta.dirname, "../../content/articles");

  try {
    const raw = readFileSync(join(contentDir, `${slug}.md`), "utf-8");
    const { meta, content } = parseFrontmatter(raw);
    return {
      slug,
      title: meta.title ?? slug,
      excerpt: meta.excerpt ?? "",
      author: meta.author ?? "Unknown",
      publishedAt: meta.publishedAt ?? "",
      content,
    };
  } catch {
    return null;
  }
}

// -- Pre-render handlers ----------------------------------------------------

// Article list -- reads all .md files from content/articles/
export const ArticlesIndex = createPrerenderHandler(async (ctx) => {
  const articles = await readAllArticles();

  const meta = ctx.use(Meta);
  meta({ title: "Articles - RSC Router Cloudflare" });
  meta({
    name: "description",
    content: "Articles about pre-rendering, caching, and RSC patterns",
  });

  const breadcrumb = ctx.use(Breadcrumbs);
  breadcrumb({ label: "Home", href: href("home") });
  breadcrumb({ label: "Articles", href: href("articles.index") });

  return (
    <div data-testid="articles-index">
      <h1 data-testid="articles-title">Articles</h1>
      <p style={{ color: "#666", marginBottom: "2rem" }}>
        Pre-rendered articles read from markdown files at build time.
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
                to={href("articles.detail", { slug: article.slug })}
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
        This page is pre-rendered at build time from {articles.length} markdown
        files.
      </p>
    </div>
  );
});

// Article detail -- scans content dir for slugs, reads each .md file
export const ArticleDetail = createPrerenderHandler(
  // getParams: discover all slugs from the filesystem
  async () => {
    const { readdirSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const contentDir = resolve(import.meta.dirname, "../../content/articles");
    const files = readdirSync(contentDir).filter((f: string) => f.endsWith(".md"));
    return files.map((f: string) => ({ slug: f.replace(/\.md$/, "") }));
  },
  // handler: read the specific article file
  async (ctx) => {
    const article = await readArticle(ctx.params.slug);

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
    breadcrumb({ label: "Home", href: href("home") });
    breadcrumb({ label: "Articles", href: href("articles.index") });
    breadcrumb({
      label: article.title,
      href: href("articles.detail", { slug: article.slug }),
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
            to={href("articles.index")}
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
          This page is pre-rendered at build time from markdown.
        </footer>
      </article>
    );
  }
);

// -- URL patterns -----------------------------------------------------------

export const articlesPatterns = urls(({ path }) => [
  path("/", ArticlesIndex, { name: "index" }),
  path("/:slug", ArticleDetail, { name: "detail" }),
]);
