import { Meta, Breadcrumbs } from "@rangojs/router";
import { Outlet, Link } from "@rangojs/router/client";
import { BreadcrumbNav } from "../BreadcrumbNav.js";
import { SegmentsDisplay } from "../SegmentsDisplay.js";
import { NavigationStatus } from "../NavigationStatus.js";

/**
 * Root layout with HTML structure - breadcrumbs, meta, nav, and outlets
 */
export function RootLayout(ctx: any) {
  // Push "Home" breadcrumb for all routes
  const pushBreadcrumb = ctx.use(Breadcrumbs);
  pushBreadcrumb({ label: "Home", href: "/" });

  // Set default meta tags for the app
  const meta = ctx.use(Meta);
  meta({ title: "RSC Router Test App" });
  meta({ name: "description", content: "E2E test application for RSC Router" });
  // Layout-level JSON-LD (WebSite schema — present on all pages)
  meta({
    "script:ld+json": {
      "@context": "https://schema.org",
      "@type": "WebSite",
      name: "RSC Router Test App",
      url: "https://example.com",
    },
  });

  return (
    <div data-testid="app-root">
      <nav data-testid="nav">
        <Link to="/" data-testid="nav-home">
          Home
        </Link>
        {/* PPR shell-cache routes — clickable for manual testing. */}
        <Link to="/shell-cache" data-testid="nav-ppr-shell">
          PPR shell
        </Link>
        <Link to="/shell-cache/stream" data-testid="nav-ppr-stream">
          PPR stream (live/nested)
        </Link>
        <Link to="/shell-cache/no-hole" data-testid="nav-ppr-no-hole">
          PPR no-hole (negative)
        </Link>
        <Link to="/shell-cache-dsl" data-testid="nav-ppr-dsl">
          PPR DSL (middleware())
        </Link>
        <Link to="/shell-cache-action" data-testid="nav-ppr-action">
          PPR actions (hole/shell/PE)
        </Link>
        <Link
          to="/shell-cache/exec-matrix"
          data-testid="nav-ppr-exec"
          prefetch="none"
        >
          PPR navigation replay
        </Link>
        <NavigationStatus testId="nav-status" />
      </nav>
      <BreadcrumbNav testId="breadcrumbs" />
      <SegmentsDisplay />
      <div style={{ display: "flex" }}>
        <main data-testid="main-content" style={{ flex: 1 }}>
          <Outlet />
        </main>
        <Outlet name="@sidebar" />
      </div>
      <Outlet name="@modal" />
    </div>
  );
}
