"use client";

import { Link, Outlet, useRouter } from "@rangojs/router/client";

export function AppALayout() {
  const router = useRouter();
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
        {/* The same cross-app target as a plain anchor and as router.push():
            every way in is a document navigation with no RSC request. */}
        <a href="/app-b" data-testid="app-a-plain-app-b">
          App B (plain anchor)
        </a>
        <button
          type="button"
          onClick={() => router.push("/app-b")}
          data-testid="app-a-push-app-b"
        >
          App B (router.push)
        </button>
        {/* Cross-app link to a route that does NOT exist in app-b. Used by the
            cross-app -> target-404 reload regression test: it must hard-reload,
            not render app-b's 404 in-place under app-a's document. */}
        <Link to="/app-b/does-not-exist" data-testid="app-a-nav-app-b-404">
          App B (missing route)
        </Link>
        {/* Same-app link to a route that does NOT exist in app-a. Used by the
            same-app 404 test: it must stay a SOFT in-place 404 (no reload) —
            only crossing an app boundary reloads. */}
        <Link to="/app-a/does-not-exist" data-testid="app-a-nav-self-404">
          App A (missing route)
        </Link>
      </nav>
      <Outlet />
    </>
  );
}
