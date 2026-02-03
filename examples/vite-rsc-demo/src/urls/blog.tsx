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

export const blogPatterns = urls(({ path, layout, middleware, cache, revalidate, parallel, loader, loading }) => [
  layout(BlogLayout, () => [
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
      path("/:slug", BlogPostPage, { name: "post" }, () => [
        revalidate(postRevalidation),
      ]),
    ]),
  ]),
]);
