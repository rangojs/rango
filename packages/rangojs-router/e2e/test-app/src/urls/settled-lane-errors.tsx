import type { ReactNode } from "react";
import { urls } from "@rangojs/router";
import { Outlet } from "@rangojs/router/client";
import {
  SettledLaneFailPage,
  SettledLaneFlakyPage,
  SettledLaneGonePage,
  SettledLaneNav,
} from "./settled-lane-errors.client.js";
import {
  SettledLaneFailLoader,
  SettledLaneFlakyLoader,
  SettledLaneGoneLoader,
} from "./settled-lane-errors.loaders.js";

// A loader whose settled result is an error or a redirect(), committed by a
// fully-prefetched click or a back/forward restore, and one that fails in the
// background refresh after Back onto a stale entry, under a layout that must
// keep its instance (settled-lane-errors.test.ts, body in tests/shared-e2e).
export const settledLaneErrorsPatterns = urls(
  ({ path, layout, loader, loading, revalidate }) => [
    layout(SettledLaneLayout, () => [
      path("/", () => <p data-testid="sle-home">home</p>, { name: "home" }),
      path("/ok", () => <p data-testid="sle-ok">ok</p>, { name: "ok" }),
      path(
        "/fail",
        () => <SettledLaneFailPage />,
        { name: "fail" },
        () => [loader(SettledLaneFailLoader)],
      ),
      path(
        "/fail-loading",
        () => <SettledLaneFailPage />,
        { name: "failLoading" },
        () => [
          loader(SettledLaneFailLoader),
          loading(<p data-testid="sle-skeleton">loading</p>),
        ],
      ),
      path(
        "/flaky",
        () => <SettledLaneFlakyPage />,
        { name: "flaky" },
        // Reruns on the background refresh after Back onto a stale entry.
        () => [loader(SettledLaneFlakyLoader, () => [revalidate(() => true)])],
      ),
      path(
        "/gone",
        () => <SettledLaneGonePage />,
        { name: "gone" },
        () => [loader(SettledLaneGoneLoader)],
      ),
    ]),
  ],
);

export function SettledLaneLayout(): ReactNode {
  return (
    <section data-testid="sle-layout">
      <SettledLaneNav />
      <Outlet />
    </section>
  );
}
