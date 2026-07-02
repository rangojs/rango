import { Meta, Breadcrumbs } from "@rangojs/router";
import type { Handler } from "@rangojs/router";
import { Link } from "@rangojs/router/client";

/**
 * Blog index page handler
 */
export const BlogIndexHandler: Handler<"blog.index"> = (ctx) => {
  const pushBreadcrumb = ctx.use(Breadcrumbs);
  const meta = ctx.use(Meta);
  pushBreadcrumb({ label: "Blog", href: ctx.reverse("blog.index") });
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
          <Link
            to={ctx.reverse("blog.post", { postId: "post-1" })}
            data-testid="blog-post-link-1"
          >
            Post 1
          </Link>
        </li>
        <li>
          <Link
            to={ctx.reverse("blog.post", { postId: "post-2" })}
            data-testid="blog-post-link-2"
          >
            Post 2
          </Link>
        </li>
      </ul>
      <div data-testid="blog-product-links" style={{ marginTop: "1rem" }}>
        <h3>Featured Products</h3>
        <Link
          to={ctx.reverse("product.detail", { productId: "product-a" })}
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
 */
export const BlogPostHandler: Handler<"blog.post"> = (ctx) => {
  const pushBreadcrumb = ctx.use(Breadcrumbs);
  const meta = ctx.use(Meta);
  pushBreadcrumb({ label: "Blog", href: ctx.reverse("blog.index") });
  pushBreadcrumb({
    label: `Post ${ctx.params.postId}`,
    href: ctx.reverse("blog.post", { postId: ctx.params.postId }),
  });
  meta({ title: `Post ${ctx.params.postId} - Blog - RSC Router Test App` });
  meta({
    name: "description",
    content: `Content for post ${ctx.params.postId}`,
  });

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

  meta(
    (async () => {
      await new Promise((r) => setTimeout(r, 300));
      return { name: "author", content: `Author of ${ctx.params.postId}` };
    })(),
  );

  return (
    <div data-testid="blog-post-page">
      <Link to={ctx.reverse("blog.index")} data-testid="back-to-blog">
        ← Back to Blog
      </Link>
      <h1 data-testid="blog-post-title">Post: {ctx.params.postId}</h1>
      <p data-testid="blog-post-content">
        Content for post {ctx.params.postId}
      </p>
      {/* Soft-nav target with a deferred Meta title — used to assert the previous
          page's title is kept (not blanked) while the deferred meta resolves. */}
      <Link to="/suspense-stream-meta" data-testid="blog-to-suspense-meta">
        suspense-stream-meta
      </Link>
    </div>
  );
};
