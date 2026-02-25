import { Outlet } from "@rangojs/router/client";
import { ArticleStatsSidebar } from "../components/ArticleStatsSidebar.js";

// Runtime layout — wraps all article routes, NOT pre-rendered.
// Only contains Outlet; parallel slots live inside the route handlers.
// The rendered-at timestamp proves this runs at request time, not build time.
export function ArticlesLayout() {
  return (
    <div data-testid="articles-layout">
      <Outlet />
      <p
        data-testid="layout-rendered-at"
        style={{ fontSize: "0.75rem", color: "#999", marginTop: "1rem" }}
      >
        Layout rendered at: {new Date().toISOString()}
      </p>
    </div>
  );
}

// Parallel slot handler — returns a client component that uses useLoader
// to read fresh loader data resolved at request time.
export function ArticleStatsHandler() {
  return <ArticleStatsSidebar />;
}
