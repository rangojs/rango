import { pages } from "../content";

/** Compact page index for the docs search palette (`/search-index.json`). */
export function searchIndex() {
  return {
    pages: pages.map((page) => ({
      title: page.title,
      url: page.url,
      description: page.description ?? "",
      headings: page.toc.map((entry) => ({
        text: entry.text,
        id: entry.id,
        depth: entry.depth,
      })),
    })),
  };
}
