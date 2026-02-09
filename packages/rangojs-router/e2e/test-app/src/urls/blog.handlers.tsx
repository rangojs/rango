import { scopedHref, Meta } from "@rangojs/router";
import type { Handler } from "@rangojs/router";
import { Link } from "@rangojs/router/client";
import { Breadcrumbs } from "../handles.js";
import type { blogPatterns } from "./blog.js";

/**
 * Blog index page handler
 * Demonstrates scopedHref for type-safe local route names
 */
export const BlogIndexHandler: Handler<"/"> = (ctx) => {
  // Use scopedHref for type-safe local route names
  const href = scopedHref<typeof blogPatterns>(ctx.href);
  const pushBreadcrumb = ctx.use(Breadcrumbs);
  const meta = ctx.use(Meta);
  pushBreadcrumb({ label: "Blog", href: href("index") });
  meta({ title: "Blog - RSC Router Test App" });
  meta({ name: "description", content: "Blog posts from RSC Router" });

  return (
    <div data-testid="blog-index-page">
      <Link to="/" data-testid="back-link">
        ← Back to Home
      </Link>
      <h1 data-testid="blog-title">Blog</h1>
      <p data-testid="blog-description">Welcome to the blog</p>
      <ul data-testid="blog-posts">
        <li>
          {/* Use scoped href for local route with params */}
          <Link
            to={href("post", { postId: "post-1" })}
            data-testid="blog-post-link-1"
          >
            Post 1
          </Link>
        </li>
        <li>
          <Link
            to={href("post", { postId: "post-2" })}
            data-testid="blog-post-link-2"
          >
            Post 2
          </Link>
        </li>
      </ul>
      <div data-testid="blog-product-links" style={{ marginTop: "1rem" }}>
        <h3>Featured Products</h3>
        {/* Cross-module: use absolute name */}
        <Link
          to={href("product.detail", { productId: "product-a" })}
          data-testid="blog-product-link"
        >
          View Product A
        </Link>
      </div>
    </div>
  );
};

/**
 * Blog post detail handler
 * Demonstrates async meta streaming
 */
export const BlogPostHandler: Handler<"/:postId"> = (ctx) => {
  const href = scopedHref<typeof blogPatterns>(ctx.href);

  const pushBreadcrumb = ctx.use(Breadcrumbs);
  const meta = ctx.use(Meta);
  pushBreadcrumb({ label: "Blog", href: href("index") });
  pushBreadcrumb({
    label: `Post ${ctx.params.postId}`,
    href: href("post", { postId: ctx.params.postId }),
  });
  meta({ title: `Post ${ctx.params.postId} - Blog - RSC Router Test App` });
  meta({
    name: "description",
    content: `Content for post ${ctx.params.postId}`,
  });

  // Test async meta with Promise - og:description streams in after 500ms
  meta(
    new Promise((resolve) =>
      setTimeout(
        () =>
          resolve({
            property: "og:description",
            content: `Async meta for ${ctx.params.postId}`,
          }),
        500,
      ),
    ),
  );

  // Test async meta with IIFE pattern - og:author streams in after 300ms
  meta(
    (async () => {
      await new Promise((r) => setTimeout(r, 300));
      return { name: "author", content: `Author of ${ctx.params.postId}` };
    })(),
  );

  return (
    <div data-testid="blog-post-page">
      <Link to={href("index")} data-testid="back-to-blog">
        ← Back to Blog
      </Link>
      <h1 data-testid="blog-post-title">Post: {ctx.params.postId}</h1>
      <p data-testid="blog-post-content">
        Content for post {ctx.params.postId}
      </p>
    </div>
  );
};
