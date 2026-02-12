"use client";

import { Link, Outlet } from "@rangojs/router/client";

export function SiteLayout() {
  return (
    <>
      <nav data-testid="site-nav">
        <Link to="/" data-testid="site-nav-home">
          Home
        </Link>
        <Link to="/about" data-testid="site-nav-about">
          About
        </Link>
      </nav>
      <Outlet />
    </>
  );
}
