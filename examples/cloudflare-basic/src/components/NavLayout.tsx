"use client";

import { Link, Outlet, useHref } from "@rangojs/router/client";
import { BreadcrumbNav } from "./BreadcrumbNav.js";

export function NavLayout() {
  const href = useHref();

  return (
    <>
      <nav data-testid="nav">
        <Link to={href("home")} data-testid="nav-home">
          Home
        </Link>
        <Link to={href("about")} data-testid="nav-about">
          About
        </Link>
        <Link to={href("counter")} data-testid="nav-counter">
          Counter
        </Link>
        <Link to={href("blog")} data-testid="nav-blog">
          Blog
        </Link>
        <Link to={href("theme")} data-testid="nav-theme">
          Theme
        </Link>
        <Link to={href("slow1")} data-testid="nav-slow-1">
          Slow 1
        </Link>
        <Link to={href("slow2")} data-testid="nav-slow-2">
          Slow 2
        </Link>
        <Link to={href("fast")} data-testid="nav-fast">
          Fast
        </Link>
      </nav>
      <BreadcrumbNav />
      <Outlet />
    </>
  );
}
