import { map } from "rsc-router/server";
import type { blogRoutes } from "../routes.js";
import { BlogLayout } from "../layouts/BlogLayout.js";
import { IndexRoute, PostRoute } from "./blog/routes.js";
import { postRevalidation } from "./blog/revalidation.js";
import { loggerMiddleware } from "./blog/middleware.js";
import { BlogSidebarLoader } from "./blog/loaders/sidebar.js";
import { BlogSidebar, BlogSidebarSkeleton } from "./blog/components/sidebar.js";

/**
 * Blog handlers - demonstrates revalidation and parallel routes
 * Array-based API with use() pattern
 * Note: RootLayout is now used as the document component in router.tsx
 */
export default map<typeof blogRoutes>(
  ({ route, layout, middleware, revalidate, parallel, loader, loading }) => [
    layout(<BlogLayout />, () => [
      middleware(...loggerMiddleware),

      parallel(
        {
          "@sidebar": async (ctx) => {
            const data = await ctx.use(BlogSidebarLoader);
            return <BlogSidebar data={data} />;
          },
        },
        () => [
          loader(BlogSidebarLoader),
          revalidate(({ actionId }) => actionId?.includes("sidebar") ?? false),
          loading(<BlogSidebarSkeleton />),
        ]
      ),

      route("index", IndexRoute),

      route("post", PostRoute, () => [revalidate(postRevalidation)]),
    ]),
  ]
);
