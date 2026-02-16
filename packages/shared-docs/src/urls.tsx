import { urls } from "@rangojs/router";
import type { DocsConfig } from "./index.js";
import { DocsIndex } from "./components/DocsIndex.js";
import { DocsArticle } from "./components/DocsArticle.js";
import { searchArticles } from "./search.js";
import { DocsLayout, RefIndex, RefDetail } from "./handlers.js";

export function createDocsPatterns(config: DocsConfig) {
  const { articles } = config;

  return urls(({ path, layout }) => [
    // Static layout: sidebar rendered once at build time via node:fs
    layout(DocsLayout, () => [
      // Runtime: consumer-provided articles
      path("/", (ctx) => <DocsIndex articles={articles} reverse={ctx.reverse} />, {
        name: "index",
      }),

      path.json(
        "/api/search",
        (ctx) => {
          const q = ctx.searchParams.get("q") ?? "";
          return searchArticles(articles, q);
        },
        { name: "search" },
      ),

      path.md(
        "/:slug/raw",
        (ctx) => {
          const article = articles.find((a) => a.slug === ctx.params.slug);
          if (!article) return "# Not Found";
          return article.content;
        },
        { name: "raw" },
      ),

      // Prerender: package-local reference docs via node:fs
      path("/ref", RefIndex, { name: "refIndex" }),
      path("/ref/:slug", RefDetail, { name: "refDetail" }),

      // Runtime detail (after /ref to avoid catching "ref" as slug)
      path(
        "/:slug",
        (ctx) => (
          <DocsArticle
            article={articles.find((a) => a.slug === ctx.params.slug) ?? null}
            slug={ctx.params.slug}
            reverse={ctx.reverse}
          />
        ),
        { name: "detail" },
      ),
    ]),
  ]);
}
