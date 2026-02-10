import type { ReactNode } from "react";
import type { Handler } from "@rangojs/router";
import { BlogPostPage } from "../pages/blog.js";
import { Breadcrumbs } from "../handles/breadcrumbs.js";
import type { routes } from "./blog.gen.js";

export const BlogPostHandler: Handler<"post", routes> = (ctx) => {
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
};
