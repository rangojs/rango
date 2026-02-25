import { urls } from "@rangojs/router";
import {
  ArticlesIndex,
  PaginatedArticles,
  PaginationLayout,
  ArticleDetail,
} from "./articles-handler.js";
import { ArticlesLayout, ArticleStatsHandler } from "./articles-layout.js";
import { ArticleStatsLoader } from "../loaders/articles.js";

export const articlesPatterns = urls(({ path, layout, parallel, loader }) => [
  // Runtime layout wraps all article routes (NOT pre-rendered)
  layout(ArticlesLayout, () => [
    // Index route at /articles — pre-rendered, shows page 1 content
    path("/", ArticlesIndex, { name: "index" }, () => [
      loader(ArticleStatsLoader),
      parallel({ "@stats": ArticleStatsHandler }),
      layout(PaginationLayout),
    ]),
    // Paginated list at /articles/page/:page (pre-rendered)
    // Handler ctx.set()s pagination metadata, PaginationLayout reads via ctx.get().
    path("/page/:page", PaginatedArticles, { name: "list" }, () => [
      loader(ArticleStatsLoader),
      parallel({ "@stats": ArticleStatsHandler }),
      layout(PaginationLayout),
    ]),
    // Article detail — slug param
    path("/:slug", ArticleDetail, { name: "detail" }),
  ]),
]);
