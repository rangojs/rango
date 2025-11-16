import { map } from "rsc-router";
import type { blogRoutes } from "../routes.js";
import { RootLayout } from "../layouts/RootLayout.js";
import { BlogLayout } from "../layouts/BlogLayout.js";
import { IndexRoute, PostRoute } from "./blog/routes.js";
import { postRevalidation } from "./blog/revalidation.js";
import { loggerMiddleware } from "./blog/middleware.js";

/**
 * Blog handlers - demonstrates revalidation
 * Array-based API with use() pattern
 */
export default map<typeof blogRoutes>(({ route, layout, middleware, revalidate }) => [
  layout(<RootLayout />),

  layout(<BlogLayout />, () => [
    middleware(...loggerMiddleware),

    route("index", IndexRoute),

    route("post", PostRoute, () => [
      revalidate(postRevalidation),
    ]),
  ]),
]);
