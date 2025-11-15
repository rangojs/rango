import { map, layout, middleware, revalidate } from "rsc-router";
import type { blogRoutes } from "../routes.js";
import { RootLayout } from "../layouts/RootLayout.js";
import { BlogLayout } from "../layouts/BlogLayout.js";
import { IndexRoute, PostRoute } from "./blog/routes.js";
import { postRevalidation } from "./blog/revalidation.js";
import { loggerMiddleware } from "./blog/middleware.js";

/**
 * Blog handlers - demonstrates revalidation
 * Now uses modular folder structure (routes/, revalidation/, middleware/)
 */
export default map<typeof blogRoutes>({
  // Global layouts - apply to all blog routes
  [layout("*", "root")]: <RootLayout />,
  [layout("*", "blog")]: <BlogLayout />,

  // Global middleware - apply to all blog routes
  [middleware("*", "logger")]: loggerMiddleware,

  // Revalidation - demonstrates default behavior
  // Only revalidate blog post if slug actually changes
  [revalidate("post")]: postRevalidation,

  // Route handlers
  index: IndexRoute,
  post: PostRoute,
});
