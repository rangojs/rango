import { urls, type Handler } from "@rangojs/router";
import { Link, Outlet } from "@rangojs/router/client";
import { ClientMountSuspense } from "../components/ClientMountSuspense.js";

/**
 * #622 follow-up (HIGH) regression route group.
 *
 * A SHARED layout (`CsLayout`) with a `loading()` boundary around its outlet, and
 * two children under it:
 *  - /cs-layout/from : immediate content
 *  - /cs-layout/to   : renders a CLIENT component that suspends only on MOUNT
 *                      (post-commit) and has NO <Suspense> of its own, so its
 *                      suspension bubbles to the layout's persistent loading()
 *                      boundary.
 *
 * Navigating from -> to keeps the SAME layout segment, so its loading() boundary
 * PERSISTS across the navigation. That is the boundary whose behavior differs
 * between commit modes:
 *  - OLD startTransition commit: the persistent boundary HOLDS the previous
 *    child's content (the /from page) until the client mount-suspense settles —
 *    the old page is retained indefinitely with NO feedback.
 *  - NEW normal commit (forceAwait the ready router data, commit normally): the
 *    persistent boundary reveals its loading() fallback while the client suspense
 *    resolves, then the new content lands.
 *
 * The server render of /cs-layout/to completes immediately (the client component
 * is just a reference), so a hover prefetch's stream drains fully and the entry
 * is `complete` (fullyPrefetched) — the path the fix touches.
 */

const CsLayout: Handler = () => (
  <div data-testid="cs-layout">
    <Link to="/cs-layout/from" data-testid="cs-from-link" prefetch="hover">
      from
    </Link>
    <Link to="/cs-layout/to" data-testid="cs-to-link" prefetch="hover">
      to
    </Link>
    <Outlet />
  </div>
);

const CsFrom: Handler = () => (
  <div data-testid="cs-from-content">from-content</div>
);

const CsTo: Handler = () => <ClientMountSuspense />;

export const clientSuspensePatterns = urls(({ layout, path, loading }) => [
  layout(CsLayout, () => [
    loading(<div data-testid="cs-layout-fallback">cs-layout-loading</div>),
    path("/cs-layout/from", CsFrom, { name: "csLayoutFrom" }),
    path("/cs-layout/to", CsTo, { name: "csLayoutTo" }),
  ]),
]);
