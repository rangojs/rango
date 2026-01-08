import { map } from "rsc-router/server";
import type { blogRoutes } from "../routes.js";
import { BlogLayout } from "../layouts/BlogLayout.js";
import { IndexRoute, PostRoute } from "./blog/routes.js";
import { postRevalidation } from "./blog/revalidation.js";
import { loggerMiddleware } from "./blog/middleware.js";
import { BlogSidebarLoader } from "./blog/loaders/sidebar.js";
import { BlogSidebar, BlogSidebarSkeleton } from "./blog/components/sidebar.js";
import { Breadcrumbs } from "../handles/breadcrumbs.js";

/**
 * Blog handlers - demonstrates revalidation and parallel routes
 * Array-based API with use() pattern
 * Note: RootLayout is now used as the document component in router.tsx
 */
export default map<typeof blogRoutes>(
  ({ route, layout, middleware, revalidate, parallel, loader, loading, cache }) => [
    // Cache boundary for all blog routes - enables server-side caching
    cache({ ttl: 60 }, () => [
      layout(
      (ctx) => {
        // Push "Blog" breadcrumb for all blog routes
        const push = ctx.use(Breadcrumbs);
        push({ label: "Blog", href: "/blog" });
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
            revalidate(
              ({ actionId }) => actionId?.includes("sidebar") ?? false
            ),
            loading(<BlogSidebarSkeleton />),
          ]
        ),

        route("index", IndexRoute),

        route(
          "post",
          (ctx) => {
            // Push post title breadcrumb
            const push = ctx.use(Breadcrumbs);
            const title = ctx.params.slug
              .split("-")
              .map((w: string) => w[0].toUpperCase() + w.slice(1))
              .join(" ");
            push({
              label: title,
              href: `/blog/${ctx.params.slug}`,
              content: new Promise((res) =>
                setTimeout(
                  () =>
                    res(
                      <>
                        Content for "{title}": {new Date().toLocaleDateString()}
                      </>
                    ),
                  3000
                )
              ),
            });

            // Render the original PostRoute
            return PostRoute(ctx);
          },
          () => [revalidate(postRevalidation)]
        ),
      ]
    ),
  ]), // End cache boundary
  ]
);
