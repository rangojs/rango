import { urls } from "@rangojs/router";
import {
  BlogLayout,
  BlogIndexPage,
  blogLoggerMiddleware,
  postRevalidation,
} from "../pages/blog.js";
import { BlogSidebarLoader } from "../handlers/blog/loaders/sidebar.js";
import { BlogSidebar, BlogSidebarSkeleton } from "../handlers/blog/components/sidebar.js";
import { Breadcrumbs } from "../handles/breadcrumbs.js";
import { BlogPostHandler } from "./blog.handlers.js";

export const blogPatterns = urls(({ path, layout, middleware, cache, revalidate, parallel, loader, loading }) => [
  layout(
    (ctx) => {
      const push = ctx.use(Breadcrumbs);
      push({ label: "Blog", href: "/blog" });
      return <BlogLayout />;
    },
    () => [
      middleware(...blogLoggerMiddleware),
      parallel(
        {
          "@sidebar": async (ctx) => {
            const data = await ctx.use(BlogSidebarLoader);
            return <BlogSidebar data={data} />;
          },
        },
        () => [
          loader(BlogSidebarLoader),
          loading(<BlogSidebarSkeleton />),
        ]
      ),
      cache({ ttl: 600000000 }, () => [
        path("/", BlogIndexPage, { name: "index" }),
        path(
          "/:slug",
          BlogPostHandler,
          { name: "post" },
          () => [revalidate(postRevalidation)]
        ),
      ]),
    ]
  ),
]);
