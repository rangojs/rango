"use client";

import { Link, Outlet } from "@rangojs/router/client";

export function AppBLayout() {
  return (
    <>
      <nav data-testid="app-b-nav">
        <Link to="/app-b" data-testid="app-b-nav-home">
          App B Home
        </Link>
        <Link to="/app-b/page" data-testid="app-b-nav-page">
          App B Page
        </Link>
        <Link to="/app-a" data-testid="app-b-nav-app-a">
          Go to App A
        </Link>
      </nav>
      <Outlet />
    </>
  );
}
