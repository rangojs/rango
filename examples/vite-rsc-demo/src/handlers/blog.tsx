import { map } from "rsc-router/server";
import type { blogRoutes } from "../routes.js";
import { RootLayout } from "../layouts/RootLayout.js";
import { BlogLayout } from "../layouts/BlogLayout.js";
import { IndexRoute, PostRoute } from "./blog/routes.js";
import { postRevalidation } from "./blog/revalidation.js";
import { loggerMiddleware } from "./blog/middleware.js";
import { BlogSidebarLoader } from "./blog/loaders/sidebar.js";
import { BlogSidebar, BlogSidebarSkeleton } from "./blog/components/sidebar.js";
import { breadcrumbs } from "../handles/breadcrumbs.js";

/**
 * Blog handlers - demonstrates revalidation and parallel routes
 * Array-based API with use() pattern
 */
export default map<typeof blogRoutes>(
  ({ route, layout, middleware, revalidate, parallel, loader, loading }) => [
    layout(<RootLayout />, () => []),

    layout(
      () => {
        breadcrumbs({ label: "Blog", href: "/blog" });
        return <BlogLayout />;
      },
      () => [
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
