import { urls } from "@rangojs/router";
import { DocsLayout } from "./layout.js";
import { DocsHomePage } from "./pages/index.js";
import { DocsArticlesPage } from "./pages/articles.js";

export const docsPatterns = urls(({ path, layout }) => [
  layout(DocsLayout, () => [
    path("/", DocsHomePage, { name: "index" }),
    path("/articles", DocsArticlesPage, { name: "articles" }),
  ]),
]);
