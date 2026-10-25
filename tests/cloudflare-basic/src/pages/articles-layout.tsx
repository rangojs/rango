import { Outlet } from "@rangojs/router/client";
import { ArticleStatsSidebar } from "../components/ArticleStatsSidebar.js";

// Wraps all article routes. Only contains Outlet; parallel slots live inside
// the route handlers. A prerendered page's hit serves it from the build
// artifact with the route; the rendered-at stamp shows which render a
// navigation that holds it keeps (e2e/prerender-navigation.test.ts).
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
