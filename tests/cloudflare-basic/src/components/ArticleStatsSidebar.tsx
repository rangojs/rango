"use client";

import { useLoader } from "@rangojs/router/client";
import { ArticleStatsLoader } from "../loaders/articles.js";

// Client component that reads loader data via useLoader.
// The loader runs server-side at request time (live, not pre-rendered).
// On SSR, loader data is in the outlet context; useLoader reads it.
export function ArticleStatsSidebar() {
  const { data } = useLoader(ArticleStatsLoader);

  return (
    <div
      data-testid="articles-stats-sidebar"
      style={{ padding: "1rem", background: "#f9f9f9", borderRadius: "8px" }}
    >
      <h3 style={{ marginBottom: "0.5rem", fontSize: "1rem" }}>
        Article Stats
      </h3>
      <p
        data-testid="stats-rendered-at"
        style={{ fontSize: "0.875rem", color: "#666" }}
      >
        Rendered at: {data.renderedAt}
      </p>
    </div>
  );
}
