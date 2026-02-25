export type DocArticle = {
  slug: string;
  title: string;
  excerpt: string;
  content: string;
};

export type DocsConfig = {
  articles: DocArticle[];
};

export { createDocsPatterns } from "./urls.js";
