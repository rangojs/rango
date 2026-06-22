import { urls, type Handler } from "@rangojs/router";
import { Link, Outlet } from "@rangojs/router/client";
import { ClientMountSuspense } from "../components/ClientMountSuspense.js";
import { PtSlowContent } from "../components/PtSlowContent.js";
import { PtSlowLoader } from "../loaders/pt-slow.js";

/**
 * #622 follow-up prefetch-transition coverage (mirrors the router e2e app).
 *
 * Two scenarios, both reached via a fully-prefetched navigation (the entry's
 * stream drains so navigation takes the no-flash fast path):
 *
 *  1. /pt-slow : a loading() route whose content depends on a slow loader. A
 *     fully-prefetched commit must NOT flash pt-slow-loading — the forceAwait
 *     unwrap lands the resolved router data inline.
 *  2. /pt-layout/{from,to} : a SHARED layout with a loading() boundary; /to's
 *     CLIENT component suspends on MOUNT with no <Suspense> of its own. On the
 *     fully-prefetched nav the persistent layout boundary reveals pt-layout-loading
 *     (a NORMAL commit) instead of holding /from's content (the old startTransition
 *     bug).
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
    <Outlet />
  </div>
);

const PtFrom: Handler = () => (
  <div data-testid="pt-from-content">pt-from-content</div>
);

const PtTo: Handler = () => <ClientMountSuspense />;

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
    ]),
  ],
);
