import { urls } from "@rangojs/router";
import { ArticlesIndex, ArticleDetail } from "./articles-handler.js";
import { ArticlesLayout, ArticleStatsHandler } from "./articles-layout.js";
import { ArticleStatsLoader } from "../loaders/articles.js";

export const articlesPatterns = urls(({ path, layout, parallel, loader }) => [
  // Runtime layout wraps all article routes (NOT pre-rendered)
  layout(ArticlesLayout, () => [
    // Children of the prerender path are pre-rendered with it,
    // except loader() which is live at request time (a resolved segment)
    path("/", ArticlesIndex, { name: "index" }, () => [
      loader(ArticleStatsLoader),
      parallel({ "@stats": ArticleStatsHandler }),
    ]),
    path("/:slug", ArticleDetail, { name: "detail" }),
  ]),
]);
