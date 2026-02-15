import type { DocArticle } from "./index.js";

export function searchArticles(articles: DocArticle[], query: string) {
  if (!query) {
    return { results: articles, total: articles.length };
  }

  const q = query.toLowerCase();
  const results = articles.filter(
    (a) =>
      a.title.toLowerCase().includes(q) ||
      a.excerpt.toLowerCase().includes(q),
  );

  return { results, total: results.length };
}
