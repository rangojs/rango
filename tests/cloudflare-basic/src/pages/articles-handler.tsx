import { Meta, Prerender, Passthrough, createVar } from "@rangojs/router";
import { Link, Outlet, ParallelOutlet } from "@rangojs/router/client";
import { Breadcrumbs } from "../handles/breadcrumbs.js";

interface PaginationData {
  current: number;
  total: number;
  perPage: number;
  articleCount: number;
}

export const Pagination = createVar<PaginationData>();

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

const articles: Article[] = Object.entries(mdFiles)
  .map(([filePath, mod]) => {
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
  })
  .sort(
    (a, b) =>
      new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime(),
  );

export const ARTICLES_PER_PAGE = 5;
export const PAGE_COUNT = Math.ceil(articles.length / ARTICLES_PER_PAGE);

// Helper: renders the article card list for a given slice.
function renderArticleCards(
  pageArticles: Article[],
  reverse: (name: string, params?: Record<string, string>) => string,
) {
  return pageArticles.map((article) => (
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
  ));
}

// Index route at /articles — pre-rendered, shows page 1 content.
export const ArticlesIndex = Prerender(async (ctx) => {
  const pageArticles = articles.slice(0, ARTICLES_PER_PAGE);

  ctx.set(Pagination, {
    current: 1,
    total: PAGE_COUNT,
    perPage: ARTICLES_PER_PAGE,
    articleCount: articles.length,
  });

  const meta = ctx.use(Meta);
  meta({ title: "Articles - RSC Router Cloudflare" });
  meta({
    name: "description",
    content: "Articles about pre-rendering, caching, and RSC patterns",
  });

  const breadcrumb = ctx.use(Breadcrumbs);
  breadcrumb({ label: "Home", href: ctx.reverse("home") });
  breadcrumb({
    label: "Articles",
    href: ctx.reverse("articles.index"),
  });

  return (
    <div data-testid="articles-index" style={{ display: "flex", gap: "2rem" }}>
      <div style={{ flex: 1 }}>
        <h1 data-testid="articles-title">Articles</h1>
        <p style={{ color: "#666", marginBottom: "2rem" }}>
          Pre-rendered articles about RSC patterns and techniques.
        </p>
        <div data-testid="articles-list">
          {renderArticleCards(pageArticles, ctx.reverse)}
        </div>
        <p
          data-testid="prerender-timestamp"
          style={{ marginTop: "2rem", fontSize: "0.875rem", color: "#999" }}
        >
          Pre-rendered at: {new Date().toISOString()}
        </p>
      </div>
      <aside style={{ width: "280px", flexShrink: 0 }}>
        <ParallelOutlet name="@stats" />
      </aside>
    </div>
  );
});

// Paginated article list (pre-rendered).
// getParams(ctx) shares allArticles via ctx.set() at build time.
// Handler slices articles for each page, ctx.set(Pagination, {...}).
// PaginationLayout (orphan layout) reads ctx.get("pagination") for nav controls.
export const PaginatedArticlesDef = Prerender<{ page: string }>(
  async (ctx) => {
    ctx.set("allArticles", articles);
    return Array.from({ length: PAGE_COUNT }, (_, i) => ({
      page: String(i + 1),
    }));
  },
  async (ctx) => {
    const page = parseInt(ctx.params.page, 10);
    const start = (page - 1) * ARTICLES_PER_PAGE;
    const pageArticles = articles.slice(start, start + ARTICLES_PER_PAGE);

    ctx.set(Pagination, {
      current: page,
      total: PAGE_COUNT,
      perPage: ARTICLES_PER_PAGE,
      articleCount: articles.length,
    });

    const meta = ctx.use(Meta);
    meta({ title: "Articles - RSC Router Cloudflare" });
    meta({
      name: "description",
      content: "Articles about pre-rendering, caching, and RSC patterns",
    });

    const breadcrumb = ctx.use(Breadcrumbs);
    breadcrumb({ label: "Home", href: ctx.reverse("home") });
    breadcrumb({
      label: "Articles",
      href: ctx.reverse("articles.list", { page: "1" }),
    });

    return (
      <div
        data-testid="articles-index"
        style={{ display: "flex", gap: "2rem" }}
      >
        <div style={{ flex: 1 }}>
          <h1 data-testid="articles-title">Articles</h1>
          <p style={{ color: "#666", marginBottom: "2rem" }}>
            Pre-rendered articles about RSC patterns and techniques.
          </p>
          <div data-testid="articles-list">
            {renderArticleCards(pageArticles, ctx.reverse)}
          </div>
          <p
            data-testid="prerender-timestamp"
            style={{ marginTop: "2rem", fontSize: "0.875rem", color: "#999" }}
          >
            Pre-rendered at: {new Date().toISOString()}
          </p>
        </div>
        <aside style={{ width: "280px", flexShrink: 0 }}>
          <ParallelOutlet name="@stats" />
        </aside>
      </div>
    );
  },
  { concurrency: 2 },
);

export const PaginatedArticles = Passthrough(
  PaginatedArticlesDef,
  async (ctx) => {
    const page = parseInt(ctx.params.page, 10);
    const start = (page - 1) * ARTICLES_PER_PAGE;
    const pageArticles = articles.slice(start, start + ARTICLES_PER_PAGE);

    ctx.set(Pagination, {
      current: page,
      total: PAGE_COUNT,
      perPage: ARTICLES_PER_PAGE,
      articleCount: articles.length,
    });

    const meta = ctx.use(Meta);
    meta({ title: "Articles - RSC Router Cloudflare" });
    meta({
      name: "description",
      content: "Articles about pre-rendering, caching, and RSC patterns",
    });

    const breadcrumb = ctx.use(Breadcrumbs);
    breadcrumb({ label: "Home", href: ctx.reverse("home") });
    breadcrumb({
      label: "Articles",
      href: ctx.reverse("articles.list", { page: "1" }),
    });

    return (
      <div
        data-testid="articles-index"
        style={{ display: "flex", gap: "2rem" }}
      >
        <div style={{ flex: 1 }}>
          <h1 data-testid="articles-title">Articles</h1>
          <p style={{ color: "#666", marginBottom: "2rem" }}>
            Pre-rendered articles about RSC patterns and techniques.
          </p>
          <div data-testid="articles-list">
            {renderArticleCards(pageArticles, ctx.reverse)}
          </div>
          <p
            data-testid="prerender-timestamp"
            style={{ marginTop: "2rem", fontSize: "0.875rem", color: "#999" }}
          >
            Pre-rendered at: {new Date().toISOString()}
          </p>
        </div>
        <aside style={{ width: "280px", flexShrink: 0 }}>
          <ParallelOutlet name="@stats" />
        </aside>
      </div>
    );
  },
);

// Orphan layout that reads pagination metadata from the handler via ctx.get().
// Renders prev/next navigation controls around the article list.
export function PaginationLayout(ctx: any) {
  const pagination = ctx.get(Pagination);
  if (!pagination) return <Outlet />;

  const { current, total } = pagination;
  const hasPrev = current > 1;
  const hasNext = current < total;

  return (
    <div data-testid="pagination-layout">
      <Outlet />
      <nav
        data-testid="pagination-nav"
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginTop: "2rem",
          padding: "1rem 0",
          borderTop: "1px solid #eee",
        }}
      >
        {hasPrev ? (
          <Link
            to={
              current - 1 === 1
                ? ctx.reverse("articles.index")
                : ctx.reverse("articles.list", {
                    page: String(current - 1),
                  })
            }
            data-testid="pagination-prev"
            style={{ color: "#0070f3", textDecoration: "none" }}
          >
            &larr; Page {current - 1}
          </Link>
        ) : (
          <span
            data-testid="pagination-prev-disabled"
            style={{ color: "#ccc" }}
          >
            &larr; Previous
          </span>
        )}
        <span data-testid="pagination-info">
          Page {current} of {total}
        </span>
        {hasNext ? (
          <Link
            to={ctx.reverse("articles.list", { page: String(current + 1) })}
            data-testid="pagination-next"
            style={{ color: "#0070f3", textDecoration: "none" }}
          >
            Page {current + 1} &rarr;
          </Link>
        ) : (
          <span
            data-testid="pagination-next-disabled"
            style={{ color: "#ccc" }}
          >
            Next &rarr;
          </span>
        )}
      </nav>
    </div>
  );
}

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
    breadcrumb({ label: "Home", href: ctx.reverse("home") });
    breadcrumb({
      label: "Articles",
      href: ctx.reverse("articles.index"),
    });
    breadcrumb({
      label: article.title,
      href: ctx.reverse("articles.detail", { slug: article.slug }),
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
            to={ctx.reverse("articles.index")}
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
  },
);
