import { Link } from "@rangojs/router/client";
import { Breadcrumbs } from "../handles.js";
import { BlogReverseNav } from "./BlogReverseNav.jsx";

export function BlogIndexPage() {
  return (
    <div data-testid="blog-index-page">
      <h1 data-testid="blog-title">Blog</h1>
      <ul>
        <li>
          <Link to="/blog/hello-world" data-testid="post-link-1">
            Hello World
          </Link>
        </li>
        <li>
          <Link to="/blog/getting-started" data-testid="post-link-2">
            Getting Started
          </Link>
        </li>
      </ul>
      {/* Client-side named reverse driven by the generated urls.gen.ts routes. */}
      <BlogReverseNav />
    </div>
  );
}

// Handler form: reads the :slug param and pushes breadcrumbs via the handle.
export function BlogPostPage(ctx) {
  const slug = ctx.params.slug;
  const breadcrumb = ctx.use(Breadcrumbs);
  breadcrumb({ label: "Blog", href: "/blog" });
  breadcrumb({ label: slug, href: `/blog/${slug}` });

  return (
    <div data-testid="blog-post-page">
      <h1 data-testid="post-title">Post: {slug}</h1>
      <p data-testid="post-content">Content for {slug}</p>
      <Link to="/blog" data-testid="back-to-blog">
        Back to Blog
      </Link>
    </div>
  );
}
