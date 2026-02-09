"use client";

import { Link, Outlet, href } from "@rangojs/router/client";
import { BreadcrumbNav } from "./BreadcrumbNav.js";

export function NavLayout() {
  return (
    <>
      <nav data-testid="nav">
        <Link to={href("/")} data-testid="nav-home">
          Home
        </Link>
        <Link {...href.JSON("/api/health")} data-testid="nav-api">
          API Health
        </Link>
        <Link to={href("/about")} data-testid="nav-about">
          About
        </Link>
        <Link to={href("/counter")} data-testid="nav-counter">
          Counter
        </Link>
        <Link to={href("/blog")} data-testid="nav-blog">
          Blog
        </Link>
        <Link to={href("/articles")} data-testid="nav-articles">
          Articles
        </Link>
        <Link to={href("/guides/routing")} data-testid="nav-guides">
          Guides
        </Link>
        <Link to={href("/theme")} data-testid="nav-theme">
          Theme
        </Link>
        <Link to={href("/slow/1")} data-testid="nav-slow-1">
          Slow 1
        </Link>
        <Link to={href("/slow/2")} data-testid="nav-slow-2">
          Slow 2
        </Link>
        <Link to={href("/slow/fast")} data-testid="nav-fast">
          Fast
        </Link>
      </nav>
      <BreadcrumbNav />
      <Outlet />
    </>
  );
}
