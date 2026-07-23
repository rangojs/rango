import { urls, type Handler } from "@rangojs/router";
import { Link, Outlet } from "@rangojs/router/client";
import {
  ClientMountSuspense,
  ClientPathnameProbe,
} from "../components/ClientMountSuspense.js";
import { ClientMountSuspenseBounded } from "../components/ClientMountSuspenseBounded.js";

/**
 * Fully-prefetched commit-mode route group.
 *
 * A SHARED layout (`CsLayout`) with a `loading()` boundary around its outlet, and
 * two children under it:
 *  - /cs-layout/from : immediate content
 *  - /cs-layout/to   : renders a CLIENT component that suspends during its first
 *                      client render and has NO <Suspense> of its own, so its
 *                      suspension bubbles to the layout's persistent loading()
 *                      boundary.
 *
 * Navigating from -> to keeps the SAME layout segment, so its loading() boundary
 * PERSISTS across the navigation. That already-revealed boundary is what
 * distinguishes the commit modes (#622 -> #624 -> reinstated transition):
 *  - startTransition commit (current): the persistent boundary HOLDS the
 *    previous child's content (the /from page) until the client mount-suspense
 *    settles — no fallback flash anywhere.
 *  - normal commit (the #624 interim): the persistent boundary reveals its
 *    loading() fallback while the client suspense resolves.
 *
 * The server render of /cs-layout/to completes immediately (the client component
 * is just a reference), so a hover prefetch's stream drains fully and the entry
 * is `complete` (fullyPrefetched) — the path this pins.
 */

const CsLayout: Handler = () => (
  <div data-testid="cs-layout">
    <Link to="/cs-layout/from" data-testid="cs-from-link" prefetch="hover">
      from
    </Link>
    <Link to="/cs-layout/to" data-testid="cs-to-link" prefetch="hover">
      to
    </Link>
    <Link
      to="/cs-layout/to-bounded"
      data-testid="cs-to-bounded-link"
      prefetch="hover"
    >
      to-bounded
    </Link>
    <ClientPathnameProbe />
    <Outlet />
  </div>
);

const CsFrom: Handler = () => (
  <div data-testid="cs-from-content">from-content</div>
);

const CsTo: Handler = () => <ClientMountSuspense />;

const CsToBounded: Handler = () => <ClientMountSuspenseBounded />;

export const clientSuspensePatterns = urls(({ layout, path, loading }) => [
  layout(CsLayout, () => [
    loading(<div data-testid="cs-layout-fallback">cs-layout-loading</div>),
    path("/cs-layout/from", CsFrom, { name: "csLayoutFrom" }),
    path("/cs-layout/to", CsTo, { name: "csLayoutTo" }),
    path("/cs-layout/to-bounded", CsToBounded, { name: "csLayoutToBounded" }),
  ]),
]);
