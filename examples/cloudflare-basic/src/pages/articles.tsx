import { Meta, createPrerenderHandler, urls } from "@rangojs/router";
import { Link } from "@rangojs/router/client";
import { Breadcrumbs } from "../handles/breadcrumbs.js";
import { href } from "../router.js";

interface Article {
  slug: string;
  title: string;
  excerpt: string;
  author: string;
  publishedAt: string;
  content: string;
}

// Hardcoded article data. Previously read from .md files at build time via
// Node.js fs APIs, now inlined so the handler runs in any environment (including
// workerd) without a separate Node.js prerender server.
const articles: Article[] = [
  {
    slug: "prerender-vs-cache",
    title: "Pre-rendering vs Caching",
    excerpt:
      "Both store RSC output, but pre-rendering happens at build time while caching happens at request time.",
    author: "Docs Team",
    publishedAt: "2025-06-15",
    content: `Caching and pre-rendering both store RSC Flight payloads to avoid re-executing handlers. The key difference is *when* the payload is produced.

## Caching

The first request triggers rendering, the result is stored for subsequent requests. Good for dynamic pages with predictable traffic patterns.

## Pre-rendering

The payload is produced during \`vite build\`. No first-request cost, and build-only code (markdown parsers, file system reads) can be excluded from the production bundle entirely.

## When to Use Which

Use **caching** for pages that depend on runtime data (user sessions, real-time prices).

Use **pre-rendering** for pages whose content is fully known at build time (documentation, marketing, changelogs).`,
  },
  {
    slug: "static-params",
    title: "Static Params with getParams",
    excerpt:
      "Define which parameter combinations to pre-render at build time.",
    author: "Docs Team",
    publishedAt: "2025-07-01",
    content: `For dynamic routes like \`/articles/:slug\`, the pre-render handler needs to know which slugs to render. The \`getParams\` function returns the list of parameter objects.

## Basic Usage

The first argument to createPrerenderHandler is getParams, which returns all slugs to pre-render. The second argument is the handler, which runs once per param set.

## Auto-discovery

In practice you can scan the content directory to discover all slugs automatically. At build time, each parameter set produces a separate Flight payload. At runtime, the correct payload is served based on the URL — no file system access needed.`,
  },
  {
    slug: "what-is-prerendering",
    title: "What is Pre-rendering?",
    excerpt:
      "Pre-rendering generates HTML at build time instead of on every request.",
    author: "Docs Team",
    publishedAt: "2025-06-01",
    content: `Pre-rendering is a technique where route segments are rendered at build time and stored as static Flight payloads. At runtime the server serves the pre-built payload without executing the handler — no cold starts, no build-only dependencies shipped to production.

This is ideal for content that exists at build time: documentation, marketing pages, blog posts, changelogs. Parent layouts stay live (user data, A/B tests, cart) while only the route's own subtree is pre-rendered.

## Why Pre-render?

- **No runtime cost** — the handler doesn't run on each request
- **No build-only deps in production** — markdown parsers, file system reads stay out of the server bundle
- **Instant first response** — no cold start penalty for the first visitor

## How It Works

In dev mode, pre-render handlers run on every request just like normal handlers so you get instant feedback while developing. At build time, the handler is executed once per parameter set and the RSC Flight output is stored.`,
  },
];

// -- Pre-render handlers ----------------------------------------------------

// Article list
export const ArticlesIndex = createPrerenderHandler(async (ctx) => {
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
        This page is pre-rendered at build time from {articles.length} articles.
      </p>
    </div>
  );
});

// Article detail -- uses hardcoded slugs for getParams
export const ArticleDetail = createPrerenderHandler(
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
          This page is pre-rendered at build time.
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
