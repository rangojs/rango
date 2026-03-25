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
      </nav>
      <Outlet />
    </>
  );
}
