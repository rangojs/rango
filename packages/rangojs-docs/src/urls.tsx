import { urls } from "@rangojs/router";
import type { DocsConfig } from "./index.js";
import { DocsIndex } from "./components/DocsIndex.js";
import { DocsArticle } from "./components/DocsArticle.js";
import { searchArticles } from "./search.js";

export function createDocsPatterns(config: DocsConfig) {
  const { articles } = config;

  return urls(({ path }) => [
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
  ]);
}
