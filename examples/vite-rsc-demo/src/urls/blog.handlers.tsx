import type { ReactNode } from "react";
import type { Handler } from "@rangojs/router";
import { BlogPostPage } from "../pages/blog.js";
import { Breadcrumbs } from "../handles/breadcrumbs.js";
import { getAuthor, getPostsByAuthor } from "../handlers/blog/data/mock-data.js";
import { AuthorPage } from "../handlers/blog/routes/author.js";
import { AuthorPostsPage } from "../handlers/blog/routes/author-posts.js";

export const BlogPostHandler: Handler<"blog.post"> = (ctx) => {
  const push = ctx.use(Breadcrumbs);
  const title = ctx.params.slug
    .split("-")
    .map((w: string) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
  // Async breadcrumb content with 3s delay for streaming demo
  const asyncContent = new Promise<ReactNode>((resolve) => {
    setTimeout(() => {
      resolve(
        <span style={{ color: "#666", fontSize: "0.8rem", marginLeft: "0.5rem" }}>
          (Published {new Date().toLocaleDateString()})
        </span>
      );
    }, 3000);
  });
  push({ label: title, href: `/blog/${ctx.params.slug}`, content: asyncContent });
  return BlogPostPage(ctx);
};

export const BlogAuthorHandler: Handler<"blog.author"> = (ctx) => {
  const push = ctx.use(Breadcrumbs);
  const author = getAuthor(ctx.params.authorSlug);
  const posts = getPostsByAuthor(ctx.params.authorSlug);
  // Async breadcrumb content -- streams in post count after 2s delay
  const asyncContent = new Promise<ReactNode>((resolve) => {
    setTimeout(() => {
      resolve(
        <span style={{ color: "#666", fontSize: "0.8rem", marginLeft: "0.5rem" }}>
          ({posts.length} posts)
        </span>
      );
    }, 2000);
  });
  push({
    label: author?.name ?? ctx.params.authorSlug,
    href: `/blog/author/${ctx.params.authorSlug}`,
    content: asyncContent,
  });
  return <AuthorPage author={author!} posts={posts} />;
};

export const BlogAuthorPostsHandler: Handler<"blog.author.posts"> = (ctx) => {
  const push = ctx.use(Breadcrumbs);
  const author = getAuthor(ctx.params.authorSlug);
  const posts = getPostsByAuthor(ctx.params.authorSlug);
  push({
    label: author?.name ?? ctx.params.authorSlug,
    href: `/blog/author/${ctx.params.authorSlug}`,
  });
  push({
    label: "Posts",
    href: `/blog/author/${ctx.params.authorSlug}/posts`,
  });
  return <AuthorPostsPage author={author!} posts={posts} />;
};
