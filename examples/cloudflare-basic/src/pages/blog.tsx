import { Meta, notFound } from "@rangojs/router/server";
import { Link, Outlet, ParallelOutlet } from "@rangojs/router/client";
import type { HandlerContext } from "@rangojs/router";
import { Breadcrumbs } from "../handles/breadcrumbs.js";
import {
  getBlogPosts,
  getBlogPost,
  BlogSidebarLoader,
  type BlogSidebarData,
} from "../loaders/blog.js";
import { href } from "../router.js";

export function BlogLayout(ctx: HandlerContext) {
  const breadcrumb = ctx.use(Breadcrumbs);
  breadcrumb({ label: "Home", href: href("home") });
  breadcrumb({ label: "Blog", href: href("blog") });

  return (
    <div data-testid="blog-layout" style={{ display: "flex", gap: "2rem" }}>
      <main style={{ flex: 1 }}>
        <Outlet />
      </main>
      <aside style={{ width: "280px", flexShrink: 0 }}>
        <ParallelOutlet name="@sidebar" />
      </aside>
    </div>
  );
}

export function BlogSidebar({ data }: { data: BlogSidebarData }) {
  return (
    <div
      data-testid="blog-sidebar"
      style={{ padding: "1rem", background: "#f9f9f9", borderRadius: "8px" }}
    >
      <h3 style={{ marginBottom: "1rem", fontSize: "1rem" }}>Recent Posts</h3>
      <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {data.recentPosts.map((post) => (
          <li key={post.slug} style={{ marginBottom: "0.75rem" }}>
            <Link
              to={href("blogPost", { slug: post.slug })}
              style={{
                color: "#0070f3",
                textDecoration: "none",
                fontSize: "0.875rem",
              }}
              data-testid={`sidebar-link-${post.slug}`}
            >
              {post.title}
            </Link>
          </li>
        ))}
      </ul>
      <h3 style={{ marginTop: "1.5rem", marginBottom: "1rem", fontSize: "1rem" }}>
        Popular Tags
      </h3>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
        {data.popularTags.map((tag) => (
          <span
            key={tag}
            style={{
              fontSize: "0.75rem",
              padding: "0.25rem 0.5rem",
              background: "#e0e0e0",
              borderRadius: "4px",
            }}
            data-testid={`sidebar-tag-${tag}`}
          >
            {tag}
          </span>
        ))}
      </div>
      <p
        data-testid="sidebar-rendered-at"
        style={{ marginTop: "1.5rem", fontSize: "0.75rem", color: "#999" }}
      >
        Sidebar rendered at:
        <br />
        {data.loadedAt}
      </p>
    </div>
  );
}

export async function BlogSidebarHandler(ctx: HandlerContext) {
  const data = await ctx.use(BlogSidebarLoader);
  return <BlogSidebar data={data} />;
}

export function SidebarSkeleton() {
  return (
    <div
      data-testid="sidebar-skeleton"
      style={{ padding: "1rem", background: "#f5f5f5", borderRadius: "8px" }}
    >
      <div style={{ height: "1.25rem", background: "#ddd", borderRadius: "4px", marginBottom: "1rem", width: "60%" }} />
      <div style={{ height: "0.875rem", background: "#ddd", borderRadius: "4px", marginBottom: "0.75rem", width: "90%" }} />
      <div style={{ height: "0.875rem", background: "#ddd", borderRadius: "4px", marginBottom: "0.75rem", width: "75%" }} />
      <div style={{ height: "0.875rem", background: "#ddd", borderRadius: "4px", marginBottom: "1.5rem", width: "85%" }} />
      <div style={{ height: "1.25rem", background: "#ddd", borderRadius: "4px", marginBottom: "1rem", width: "50%" }} />
      <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
        <div style={{ height: "1.5rem", width: "3rem", background: "#ddd", borderRadius: "4px" }} />
        <div style={{ height: "1.5rem", width: "4rem", background: "#ddd", borderRadius: "4px" }} />
        <div style={{ height: "1.5rem", width: "3.5rem", background: "#ddd", borderRadius: "4px" }} />
      </div>
      <p style={{ marginTop: "1.5rem", fontSize: "0.75rem", color: "#999" }}>Loading sidebar...</p>
    </div>
  );
}

export function BlogIndexPage(ctx: HandlerContext) {
  ctx.headers.set("Cache-Control", "s-maxage=60, stale-while-revalidate=300");

  const meta = ctx.use(Meta);
  meta({ title: "Blog - RSC Router Cloudflare" });
  meta({ name: "description", content: "Read our latest articles about RSC, Cloudflare, and web development" });

  const posts = getBlogPosts();

  return (
    <div data-testid="blog-index">
      <h1 data-testid="blog-title">Blog</h1>
      <p style={{ color: "#666", marginBottom: "2rem" }}>
        Articles about RSC, Cloudflare Workers, and modern web development.
      </p>
      <div data-testid="blog-posts-list">
        {posts.map((post) => (
          <article
            key={post.slug}
            style={{ marginBottom: "2rem", paddingBottom: "1.5rem", borderBottom: "1px solid #eee" }}
            data-testid={`blog-post-${post.slug}`}
          >
            <h2 style={{ marginBottom: "0.5rem" }}>
              <Link to={href("blogPost", { slug: post.slug })} style={{ color: "#0070f3", textDecoration: "none" }} data-testid={`blog-link-${post.slug}`}>
                {post.title}
              </Link>
            </h2>
            <p style={{ color: "#666", fontSize: "0.875rem", marginBottom: "0.5rem" }}>
              By {post.author} on {post.publishedAt}
            </p>
            <p style={{ marginBottom: "0.5rem" }}>{post.excerpt}</p>
            <div style={{ display: "flex", gap: "0.5rem" }}>
              {post.tags.map((tag) => (
                <span key={tag} style={{ fontSize: "0.75rem", padding: "0.25rem 0.5rem", background: "#f0f0f0", borderRadius: "4px" }}>
                  {tag}
                </span>
              ))}
            </div>
          </article>
        ))}
      </div>
      <p data-testid="cache-info" style={{ marginTop: "2rem", fontSize: "0.875rem", color: "#999" }}>
        This page is cached at the edge with TTL=60s, SWR=300s.
        <br />
        Rendered at: {new Date().toISOString()}
      </p>
    </div>
  );
}

export function BlogPostPage(ctx: HandlerContext<{ slug: string }>) {
  ctx.headers.set("Cache-Control", "s-maxage=60, stale-while-revalidate=300");
  const post = getBlogPost(ctx.params.slug);

  if (!post) {
    notFound();
  }

  const meta = ctx.use(Meta);
  meta({ title: `${post.title} - Blog - RSC Router` });
  meta({ name: "description", content: post.excerpt });

  const breadcrumb = ctx.use(Breadcrumbs);
  breadcrumb({ label: post.title, href: href("blogPost", { slug: post.slug }) });

  return (
    <article data-testid="blog-post-detail">
      <nav style={{ marginBottom: "1rem", paddingBottom: "0.5rem", borderBottom: "1px solid #eee" }}>
        <Link to={href("blog")} style={{ color: "#0070f3", textDecoration: "none" }}>&larr; Back to Blog</Link>
      </nav>
      <header style={{ marginBottom: "2rem" }}>
        <h1 data-testid="post-title">{post.title}</h1>
        <p style={{ color: "#666", fontSize: "0.875rem" }}>
          By <span data-testid="post-author">{post.author}</span> on <span data-testid="post-date">{post.publishedAt}</span>
        </p>
        <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.5rem" }}>
          {post.tags.map((tag) => (
            <span key={tag} style={{ fontSize: "0.75rem", padding: "0.25rem 0.5rem", background: "#f0f0f0", borderRadius: "4px" }}>
              {tag}
            </span>
          ))}
        </div>
      </header>
      <div data-testid="post-content" style={{ lineHeight: 1.7, whiteSpace: "pre-wrap" }}>
        {post.content}
      </div>
      <footer data-testid="cache-info" style={{ marginTop: "3rem", paddingTop: "1rem", borderTop: "1px solid #eee", fontSize: "0.875rem", color: "#999" }}>
        This page is cached at the edge with TTL=60s, SWR=300s.
        <br />
        Rendered at: {new Date().toISOString()}
      </footer>
    </article>
  );
}
