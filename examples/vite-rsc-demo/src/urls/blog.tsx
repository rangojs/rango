import { urls } from "@rangojs/router/server";
import {
  BlogLayout,
  BlogIndexPage,
  BlogPostPage,
  blogLoggerMiddleware,
  postRevalidation,
} from "../pages/blog.js";

export const blogPatterns = urls(({ path, layout, middleware, cache, revalidate }) => [
  layout(BlogLayout, () => [
    middleware(...blogLoggerMiddleware),
    cache({ ttl: 600000000 }, () => [
      path("/", BlogIndexPage, { name: "index" }),
      path("/:slug", BlogPostPage, { name: "post" }, () => [
        revalidate(postRevalidation),
      ]),
    ]),
  ]),
]);
