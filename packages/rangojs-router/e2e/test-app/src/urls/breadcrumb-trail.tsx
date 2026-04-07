import { urls, Breadcrumbs } from "@rangojs/router";
import { Outlet, Link } from "@rangojs/router/client";
import { TrailBreadcrumbs } from "../components/TrailBreadcrumbs.js";

/**
 * Test routes for the built-in Breadcrumbs handle with a user-land component.
 * Exercises useHandle(Breadcrumbs), async content, and soft navigation.
 */

function TrailLayout(ctx: any) {
  const breadcrumb = ctx.use(Breadcrumbs);
  breadcrumb({ label: "Trail", href: "/breadcrumb-trail" });
  return (
    <div data-testid="trail-root">
      <TrailBreadcrumbs />
      <nav data-testid="trail-nav">
        <Link to="/breadcrumb-trail" data-testid="trail-link-trail">
          Trail
        </Link>
        <Link to="/breadcrumb-trail/docs" data-testid="trail-link-docs">
          Docs
        </Link>
        <Link
          to="/breadcrumb-trail/docs/getting-started"
          data-testid="trail-link-getting-started"
        >
          Getting Started
        </Link>
      </nav>
      <Outlet />
    </div>
  );
}

function TrailIndex() {
  return (
    <div data-testid="trail-index-page">
      <h1>Trail Home</h1>
    </div>
  );
}

function TrailDocs(ctx: any) {
  const breadcrumb = ctx.use(Breadcrumbs);
  breadcrumb({ label: "Docs", href: "/breadcrumb-trail/docs" });
  return (
    <div data-testid="trail-docs-page">
      <h1>Docs</h1>
    </div>
  );
}

function TrailDocsGuide(ctx: any) {
  const breadcrumb = ctx.use(Breadcrumbs);
  breadcrumb({ label: "Docs", href: "/breadcrumb-trail/docs" });
  breadcrumb({
    label: "Getting Started",
    href: "/breadcrumb-trail/docs/getting-started",
    content: new Promise((resolve) =>
      setTimeout(
        () => resolve(<span data-testid="trail-async-content">v2.0</span>),
        500,
      ),
    ),
  });
  return (
    <div data-testid="trail-guide-page">
      <h1>Getting Started</h1>
      <Link to="/breadcrumb-trail/docs" data-testid="trail-back-to-docs">
        Back to Docs
      </Link>
    </div>
  );
}

export const breadcrumbTrailPatterns = urls(({ path, layout }) => [
  layout(TrailLayout, () => [
    path("/breadcrumb-trail", TrailIndex, { name: "breadcrumbTrail.index" }),
    path("/breadcrumb-trail/docs", TrailDocs, {
      name: "breadcrumbTrail.docs",
    }),
    path("/breadcrumb-trail/docs/getting-started", TrailDocsGuide, {
      name: "breadcrumbTrail.guide",
    }),
  ]),
]);
