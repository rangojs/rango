"use client";

import { Link, Outlet } from "@rangojs/router/client";

// The label is the client-only change the suite makes: it alters the client
// bundle (and so the client asset names) without touching any server module.
export const NAV_LABEL = "nav v1";

export function Nav({ app }: { app: string }) {
  return (
    <>
      <nav data-testid="nav" data-label={NAV_LABEL}>
        <span data-testid="app">{app}</span>
        <Link to="/" data-testid="link-home">
          Home
        </Link>
        <Link to="/one" data-testid="link-one">
          One
        </Link>
        <Link to="/two" data-testid="link-two">
          Two
        </Link>
        <Link to="/three" data-testid="link-three">
          Three
        </Link>
      </nav>
      <Outlet />
    </>
  );
}
