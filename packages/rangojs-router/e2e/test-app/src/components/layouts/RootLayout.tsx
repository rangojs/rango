import { Meta } from "@rangojs/router";
import { Outlet, Link } from "@rangojs/router/client";
import { Breadcrumbs } from "../../handles.js";
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

  return (
    <div data-testid="app-root">
      <nav data-testid="nav">
        <Link to="/" data-testid="nav-home">
          Home
        </Link>
        <NavigationStatus testId="nav-status" />
      </nav>
      <BreadcrumbNav testId="breadcrumbs" />
      <SegmentsDisplay />
      <main data-testid="main-content">
        <Outlet />
      </main>
      <Outlet name="@modal" />
    </div>
  );
}
