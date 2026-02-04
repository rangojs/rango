import { urls } from "@rangojs/router";
import { BlogIndexHandler, BlogPostHandler } from "./blog.handlers.js";

/**
 * Blog URL patterns
 * Routes: blog.index, blog.post
 *
 * Handlers are in blog.handlers.tsx for cleaner route definitions
 */
export const blogPatterns = urls(({ path, cache }) => [
  cache({ ttl: 600 }, () => [
    path("/", BlogIndexHandler, { name: "index" }),
    path("/:postId", BlogPostHandler, { name: "post" }),
  ]),
]);
