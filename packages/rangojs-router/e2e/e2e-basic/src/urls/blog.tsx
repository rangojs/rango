import { urls } from "@rangojs/router";
import { BlogLayout } from "../components/layouts/index.js";
import { BlogIndexPage, BlogPostPage } from "../components/pages/index.js";

/**
 * Blog URL patterns
 * Routes: blog.index, blog.post
 */
export const blogPatterns = urls(({ path, layout }) => [
  layout(BlogLayout, () => [
    path("/", BlogIndexPage, { name: "index" }),
    path("/:slug", (ctx) => <BlogPostPage params={ctx.params} />, { name: "post" }),
  ]),
]);
