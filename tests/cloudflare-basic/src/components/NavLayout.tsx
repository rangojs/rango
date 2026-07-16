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
        <Link {...href.json("/api/health")} data-testid="nav-api">
          API Health
        </Link>
        <Link to={href("/about")} data-testid="nav-about">
          About
        </Link>
        <Link to={href("/counter")} data-testid="nav-counter">
          Counter
        </Link>
        <Link to="/cache-lab" data-testid="nav-cache-lab">
          Cache Lab
        </Link>
        <Link to={href("/api-demo")} data-testid="nav-api-demo">
          API Demo
        </Link>
        <Link to={href("/blog")} data-testid="nav-blog">
          Blog
        </Link>
        <Link to={href("/articles")} data-testid="nav-articles">
          Articles
        </Link>
        <Link to={href("/releases")} data-testid="nav-releases">
          Releases
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
        <Link to={href("/api/health")} data-testid="nav-api-health">
          API Health
        </Link>
        <Link to={href("/static-content")} data-testid="nav-static-content">
          Static Content
        </Link>
        <Link to={href("/docs")} data-testid="nav-docs">
          Docs
        </Link>
        {/* PPR shell-cache routes — clickable for manual testing. */}
        <Link to={href("/ppr-shell")} data-testid="nav-ppr-shell">
          PPR shell
        </Link>
        <Link to={href("/ppr-shell/stream")} data-testid="nav-ppr-stream">
          PPR stream (live/nested)
        </Link>
        <Link to={href("/ppr-shell/no-hole")} data-testid="nav-ppr-no-hole">
          PPR no-hole (negative)
        </Link>
        <Link
          to="/ppr-shell/exec-matrix"
          data-testid="nav-ppr-exec"
          prefetch="none"
        >
          PPR navigation replay
        </Link>
        <Link
          to="/ppr-shell/exec-matrix?transition=drop"
          data-testid="nav-ppr-exec-drop"
          prefetch="none"
        >
          PPR navigation replay without transition
        </Link>
        <Link
          to="/ppr-shell/slot-hole?probe=fragment-prefetch-warm"
          data-testid="nav-ppr-fragment-prefetch-warm"
          prefetch="hover"
        >
          PPR fragment warm prefetch
        </Link>
        <Link
          to="/ppr-shell/slot-hole?probe=fragment-prefetch-inflight"
          data-testid="nav-ppr-fragment-prefetch-inflight"
          prefetch="hover"
        >
          PPR fragment in-flight prefetch
        </Link>
        <Link
          to="/ppr-shell/inline-action?probe=ppr-inline-nav"
          data-testid="nav-ppr-inline-action"
          prefetch="none"
        >
          PPR inline action
        </Link>
        <Link
          to="/ppr-shell/passthrough/baked?probe=ppp-action-nav"
          data-testid="nav-prerender-ppr-action"
          prefetch="none"
        >
          Prerender PPR action
        </Link>
      </nav>
      <BreadcrumbNav />
      <Outlet />
    </>
  );
}
