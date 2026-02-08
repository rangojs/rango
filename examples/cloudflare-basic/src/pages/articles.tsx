import { urls } from "@rangojs/router";
import { ArticlesIndex, ArticleDetail } from "./articles-handler.js";

export { ArticlesIndex, ArticleDetail };

export const articlesPatterns = urls(({ path }) => [
  path("/", ArticlesIndex, { name: "index" }),
  path("/:slug", ArticleDetail, { name: "detail" }),
]);
