import type { ReactNode } from "react";
import { urls } from "@rangojs/router/server";
import {
  BlogLayout,
  BlogIndexPage,
  BlogPostPage,
  blogLoggerMiddleware,
  postRevalidation,
} from "../pages/blog.js";
import { BlogSidebarLoader } from "../handlers/blog/loaders/sidebar.js";
import { BlogSidebar, BlogSidebarSkeleton } from "../handlers/blog/components/sidebar.js";
import { Breadcrumbs } from "../handles/breadcrumbs.js";

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
          (ctx) => {
            const push = ctx.use(Breadcrumbs);
            const title = ctx.params.slug
              .split("-")
              .map((w: string) => w[0].toUpperCase() + w.slice(1))
              .join(" ");
            // Async breadcrumb content with 3s delay for streaming demo
            const asyncContent = new Promise<ReactNode>((resolve) => {
              setTimeout(() => {
                resolve(
                  <span style={{ color: "#666", fontSize: "0.8rem", marginLeft: "0.5rem" }}>
                    (Published {new Date().toLocaleDateString()})
                  </span>
                );
              }, 3000);
            });
            push({ label: title, href: `/blog/${ctx.params.slug}`, content: asyncContent });
            return BlogPostPage(ctx);
          },
          { name: "post" },
          () => [revalidate(postRevalidation)]
        ),
      ]),
    ]
  ),
]);
