import { urls, Breadcrumbs } from "@rangojs/router";
import { Outlet, Link } from "@rangojs/router/client";
import { Suspense } from "react";
import {
  TrailBreadcrumbs,
  DeferredTrailBreadcrumbs,
} from "../components/TrailBreadcrumbs.js";

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

// EXPERIMENT (handles-completion Q6): can a handler DECIDE to push a handle
// synchronously (it holds ctx, so the push lands before the handles generator
// seals) while a DEEP async component, far from the handler, produces the VALUE
// late? The content is a Promise pushed at handler time and resolved by an async
// child during its own render. If the breadcrumb content still renders, then
// "decide-sync, resolve-late" works on the existing Flight transport with no new
// machinery — which makes the completion-detection answer the small
// `ctx.use(Handle).defer()` API + docs rather than the out-of-band stream
// redesign (option A).
function DeferredResolvePage(ctx: any) {
  const breadcrumb = ctx.use(Breadcrumbs);
  // Decide to push the crumb now (slot reserved before the stream seals); a deep
  // async component resolves the WHOLE item later via the resolver — the same
  // call shape as breadcrumb({...}).
  const resolveCrumb = breadcrumb.defer({ within: 5000, else: null });

  async function DeepResolver() {
    await new Promise((r) => setTimeout(r, 300));
    resolveCrumb({
      label: "Deferred",
      href: "/breadcrumb-trail/deferred",
      content: (
        <span data-testid="deferred-resolved">resolved-by-deep-component</span>
      ),
    });
    return <div data-testid="deep-resolver-done">deep done</div>;
  }

  return (
    <div data-testid="deferred-resolve-page">
      <DeferredTrailBreadcrumbs />
      <Suspense fallback={<div data-testid="deep-loading">loading</div>}>
        <DeepResolver />
      </Suspense>
    </div>
  );
}

// Safety net: a deferred slot whose resolver is NEVER called. The short timeout
// must auto-resolve the slot to `else` so the response flushes instead of
// hanging forever on the open Flight row.
function DeferredTimeoutPage(ctx: any) {
  const breadcrumb = ctx.use(Breadcrumbs);
  breadcrumb.defer({
    within: 300,
    else: {
      label: "Forgotten",
      href: "/breadcrumb-trail/deferred-timeout",
      content: <span data-testid="deferred-fallback">fallback-content</span>,
    },
  });
  // Resolver intentionally never called.

  return (
    <div data-testid="deferred-timeout-page">
      <DeferredTrailBreadcrumbs />
    </div>
  );
}

export const breadcrumbTrailPatterns = urls(({ path, layout }) => [
  path("/breadcrumb-trail/deferred", DeferredResolvePage, {
    name: "breadcrumbTrail.deferred",
  }),
  path("/breadcrumb-trail/deferred-timeout", DeferredTimeoutPage, {
    name: "breadcrumbTrail.deferredTimeout",
  }),
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
