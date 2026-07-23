import { urls, type Handler } from "@rangojs/router";
import { Link, Outlet } from "@rangojs/router/client";
import {
  ClientMountSuspense,
  ClientPathnameProbe,
} from "../components/ClientMountSuspense.js";
import { ClientMountSuspenseBounded } from "../components/ClientMountSuspenseBounded.js";
import { PtSlowContent } from "../components/PtSlowContent.js";
import { PtSlowLoader } from "../loaders/pt-slow.js";

/**
 * Fully-prefetched commit-mode coverage (mirrors the router e2e app).
 *
 * Scenarios, all reached via a fully-prefetched navigation (the entry's
 * stream drains so navigation takes the no-flash startTransition path):
 *
 *  1. /pt-slow : a loading() route whose content depends on a slow loader. A
 *     fully-prefetched commit must NOT flash pt-slow-loading — the forceAwait
 *     unwrap lands the resolved router data inline.
 *  2. /pt-layout/{from,to} : a SHARED layout with a loading() boundary; /to's
 *     CLIENT component suspends during its first render with no <Suspense> of
 *     its own. The startTransition commit HOLDS /from's content at the
 *     already-revealed layout boundary until the client promise resolves
 *     (#622 -> #624 -> reinstated transition).
 *  3. /pt-layout/to-bounded : the same pattern WITH a component-own
 *     <Suspense>. That boundary is newly mounted by the nav, so React reveals
 *     its LOCAL fallback immediately even inside the transition — the escape
 *     hatch from the layout-level hold.
 */

const PtSlowPage: Handler = () => <PtSlowContent loader={PtSlowLoader} />;

const PtLayout: Handler = () => (
  <div data-testid="pt-layout">
    <Link to="/pt-layout/from" data-testid="pt-from-link" prefetch="hover">
      from
    </Link>
    <Link to="/pt-layout/to" data-testid="pt-to-link" prefetch="hover">
      to
    </Link>
    <Link
      to="/pt-layout/to-bounded"
      data-testid="pt-to-bounded-link"
      prefetch="hover"
    >
      to-bounded
    </Link>
    <ClientPathnameProbe />
    <Outlet />
    <div style={{ height: "2000px" }} aria-hidden="true" />
    <Link
      to="/about?observer-facade=1"
      data-testid="pt-offscreen-viewport-link"
      prefetch="viewport"
    >
      offscreen viewport link
    </Link>
  </div>
);

const PtFrom: Handler = () => (
  <div data-testid="pt-from-content">pt-from-content</div>
);

const PtTo: Handler = () => <ClientMountSuspense />;

const PtToBounded: Handler = () => <ClientMountSuspenseBounded />;

export const prefetchTransitionPatterns = urls(
  ({ layout, path, loading, loader }) => [
    path("/pt-slow", PtSlowPage, { name: "ptSlow" }, () => [
      loader(PtSlowLoader),
      loading(<div data-testid="pt-slow-loading">pt-slow-loading</div>),
    ]),
    layout(PtLayout, () => [
      loading(<div data-testid="pt-layout-loading">pt-layout-loading</div>),
      path("/pt-layout/from", PtFrom, { name: "ptLayoutFrom" }),
      path("/pt-layout/to", PtTo, { name: "ptLayoutTo" }),
      path("/pt-layout/to-bounded", PtToBounded, {
        name: "ptLayoutToBounded",
      }),
    ]),
  ],
);
