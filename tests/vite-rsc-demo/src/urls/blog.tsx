import { urls } from "@rangojs/router";
import {
  BlogLayout,
  BlogIndexPage,
  blogLoggerMiddleware,
  postRevalidation,
} from "../pages/blog.js";
import { BlogSidebarLoader } from "../handlers/blog/loaders/sidebar.js";
import {
  BlogSidebar,
  BlogSidebarSkeleton,
} from "../handlers/blog/components/sidebar.js";
import { BlogAuthorLoader } from "../handlers/blog/loaders/author.js";
import {
  AuthorModalWrapper,
  AuthorModalContent,
  AuthorModalContentSkeleton,
} from "../handlers/blog/components/AuthorModal.js";
import { shouldInterceptBlogAuthor } from "../handlers/blog/conditions/index.js";
import { Meta } from "@rangojs/router";
import { Breadcrumbs } from "../handles/breadcrumbs.js";
import {
  BlogPostHandler,
  BlogAuthorHandler,
  BlogAuthorPostsHandler,
} from "./blog.handlers.js";

export const blogPatterns = urls(
  ({
    path,
    layout,
    middleware,
    cache,
    revalidate,
    parallel,
    loader,
    loading,
    intercept,
  }) => [
    layout(
      (ctx) => {
        const push = ctx.use(Breadcrumbs);
        push({ label: "Blog", href: "/blog" });
        const meta = ctx.use(Meta);
        meta({ title: { template: "%s | Blog", default: "Blog" } });
        return <BlogLayout />;
      },
      () => [
        middleware(blogLoggerMiddleware),
        parallel(
          {
            "@sidebar": async (ctx) => {
              return <BlogSidebar />;
            },
          },
          () => [loader(BlogSidebarLoader), loading(<BlogSidebarSkeleton />)],
        ),

        // Intercept author page -- modal from index/list, direct from post pages
        intercept(
          "@modal",
          ".author",
          <AuthorModalContent />,
          { when: shouldInterceptBlogAuthor },
          () => [
            layout(<AuthorModalWrapper />),
            loading(<AuthorModalContentSkeleton />),
            loader(BlogAuthorLoader),
          ],
        ),

        cache({ ttl: 600000000 }, () => [
          path("/", BlogIndexPage, { name: "index" }),
          path("/:slug", BlogPostHandler, { name: "post" }, () => [
            revalidate(postRevalidation),
          ]),
        ]),

        // Author routes
        path("/author/:authorSlug", BlogAuthorHandler, { name: "author" }),
        path("/author/:authorSlug/posts", BlogAuthorPostsHandler, {
          name: "author.posts",
        }),
      ],
    ),
  ],
);
