import { urls } from "@rangojs/router";
import { BlogLayout } from "./BlogLayout.jsx";
import { BlogIndexPage, BlogPostPage } from "./pages.jsx";

// A self-contained URL module composed into the main router via include().
// Routes: blog.index, blog.post (with a dynamic :slug param).
export const blogPatterns = urls(({ path, layout }) => [
  layout(BlogLayout, () => [
    path("/", BlogIndexPage, { name: "index" }),
    path("/:slug", BlogPostPage, { name: "post" }),
  ]),
]);
