"use client";

import { Link, Outlet } from "@rangojs/router/client";

export function AppALayout() {
  return (
    <>
      <nav data-testid="app-a-nav">
        <Link to="/app-a" data-testid="app-a-nav-home">
          App A Home
        </Link>
        <Link to="/app-a/page" data-testid="app-a-nav-page">
          App A Page
        </Link>
        <Link to="/app-b" data-testid="app-a-nav-app-b">
          Go to App B
        </Link>
        {/* Cross-app link to a route that does NOT exist in app-b. Used by the
            cross-app -> target-404 reload regression test: it must hard-reload,
            not render app-b's 404 in-place under app-a's document. */}
        <Link to="/app-b/does-not-exist" data-testid="app-a-nav-app-b-404">
          App B (missing route)
        </Link>
      </nav>
      <Outlet />
    </>
  );
}
