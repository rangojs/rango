"use client";

import { Link, Outlet } from "@rangojs/router/client";
import { BreadcrumbNav } from "./BreadcrumbNav.js";

export function NavLayout() {
  return (
    <>
      <nav data-testid="nav">
        <Link to="/" data-testid="nav-home">
          Home
        </Link>
        <Link to="/about" data-testid="nav-about">
          About
        </Link>
        <Link to="/counter" data-testid="nav-counter">
          Counter
        </Link>
        <Link to="/blog" data-testid="nav-blog">
          Blog
        </Link>
        <Link to="/theme" data-testid="nav-theme">
          Theme
        </Link>
        <Link to="/slow/1" data-testid="nav-slow-1">
          Slow 1
        </Link>
        <Link to="/slow/2" data-testid="nav-slow-2">
          Slow 2
        </Link>
        <Link to="/slow/fast" data-testid="nav-fast">
          Fast
        </Link>
      </nav>
      <BreadcrumbNav />
      <Outlet />
    </>
  );
}
