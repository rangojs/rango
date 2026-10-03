// @vitest-environment happy-dom
import { afterEach, expect, it } from "vitest";
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { runMiddleware, withLocationStateKey } from "@rangojs/router/testing";
import { renderRoute } from "@rangojs/router/testing/dom";
import type { Middleware } from "@rangojs/router";
import {
  AppVersionPanel,
  LoadMoreList,
} from "../src/components/LocationStateOptions.js";
import {
  CarriedItems,
  GridState,
  ListSort,
  ServerPageStamp,
  type GridSnapshot,
} from "../src/location-states.js";
import {
  LoadMoreLoader,
  type LoadMorePage,
} from "../src/loaders/location-state.js";

afterEach(() => {
  cleanup();
});

// Dogfood of `clearOnReload` and the app version of location state (#994)
// against cloudflare-basic's REAL components and definitions, through the
// published testing entries. No Vite plugin here, so each definition is keyed by name; a
// definition with `clearOnReload` appends its suffix to that name.
withLocationStateKey(CarriedItems, "CarriedItems");
withLocationStateKey(ListSort, "ListSort");
withLocationStateKey(ServerPageStamp, "ServerPageStamp");
withLocationStateKey(GridState, "GridState");

const carried = ["p1-1", "p1-2", "p1-3"];
const grid: GridSnapshot = { order: "desc", page: 3 };

function LoadMorePage() {
  return <LoadMoreList basePath="/location-state-load-more" />;
}
const pageItems = (page: number): string[] =>
  [1, 2, 3].map((item) => `p${page}-${item}`);
const pageData = (page: number): LoadMorePage => ({
  page,
  items: pageItems(page),
});
const loadMore = {
  // `transition`: a navigation whose loader is pending keeps the page on
  // screen, as the app's same-route navigation does.
  routes: [
    {
      path: "/location-state-load-more",
      Component: LoadMorePage,
      transition: {},
    },
  ],
  loaders: [[LoadMoreLoader, pageData(2)]] as const,
  locationState: [
    [CarriedItems, carried],
    [ListSort, { order: "asc" }],
  ] as const,
};
const listed = (root: { getAllByRole(role: string): HTMLElement[] }) =>
  root.getAllByRole("listitem").map((item) => item.textContent);

it("clearOnReload: a client mount shows the carried items, a document load does not", async () => {
  const mounted = await renderRoute(loadMore.routes, {
    loaders: loadMore.loaders,
    locationState: loadMore.locationState,
  });
  expect(listed(mounted)).toEqual([...carried, ...pageItems(2)]);
  mounted.unmount();

  const loaded = await renderRoute(loadMore.routes, {
    hydrate: true,
    loaders: loadMore.loaders,
    locationState: loadMore.locationState,
  });
  expect(loaded.serverHtml).not.toContain("p1-1");
  expect(loaded.recoverableErrors).toEqual([]);
  expect(loaded.getByTestId("lm-sort").textContent).toBe("asc");
  expect(loaded.getAllByRole("listitem")).toHaveLength(3);
  expect(window.history.state).toEqual({ __rsc_ls_ListSort: { order: "asc" } });

  // "Load more" carries the items on screen again.
  fireEvent.click(loaded.getByTestId("lm-more"));
  await waitFor(() => expect(CarriedItems.read()).toEqual(pageItems(2)));
});

// #1029, on the app's own list: while the next page's loader is pending the
// list is still the current entry's. Its carried items change in the commit
// that brings the next page, so the list never shows an item twice.
it("load more: a pending navigation keeps the current entry's items until the next page lands", async () => {
  const { router, ...list } = await renderRoute(loadMore.routes, {
    request: "/location-state-load-more?page=2",
    loaders: loadMore.loaders,
    locationState: loadMore.locationState,
  });
  const onScreen = [...carried, ...pageItems(2)];
  expect(listed(list)).toEqual(onScreen);

  let land!: (page: LoadMorePage) => void;
  const next = new Promise<LoadMorePage>((resolve) => (land = resolve));
  await router.navigate("/location-state-load-more?page=3", {
    state: [CarriedItems(onScreen)],
    loaders: [[LoadMoreLoader, next]],
  });
  // The router is on page 3's entry; the page on screen is still page 2.
  expect(CarriedItems.read()).toEqual(onScreen);
  expect(listed(list)).toEqual(onScreen);

  await act(async () => land(pageData(3)));
  expect(listed(list)).toEqual([...onScreen, ...pageItems(3)]);
});

const appVersionRoutes = [
  {
    path: "/location-state-app-version",
    Component: () => (
      <AppVersionPanel basePath="/location-state-app-version" step="start" />
    ),
  },
];

// The app version location state is recorded under never shows up in a test:
// a seed is a definition and a value, and it reads back on a mount and on a
// document load.
it("the app version: seeds read back without one; an entry another version wrote does not", async () => {
  const seeds = [[GridState, grid]] as const;
  const mounted = await renderRoute(appVersionRoutes, { locationState: seeds });
  expect(mounted.getByTestId("grid-value").textContent).toBe("desc:3");
  expect(window.history.state).toEqual({ __rsc_ls_GridState: grid });
  mounted.unmount();

  const loaded = await renderRoute(appVersionRoutes, {
    hydrate: true,
    locationState: seeds,
  });
  expect(loaded.serverHtml).toContain(">none<");
  expect(loaded.recoverableErrors).toEqual([]);
  expect(loaded.getByTestId("grid-value").textContent).toBe("desc:3");

  // An entry as a deployed build leaves it: back/forward onto it reads nothing.
  await act(async () => {
    window.history.replaceState(
      { __rsc_ls_GridState: grid, state: { from: "panel" }, __rsc_lsv: "b1" },
      "",
    );
    window.dispatchEvent(new Event("popstate"));
  });
  expect(loaded.getByTestId("grid-value").textContent).toBe("none");
  expect(loaded.getByTestId("plain-value").textContent).toBe("none");
});

it("a middleware's state is keyed by the definition's key and carries no version", async () => {
  const remember: Middleware = async (ctx, next) => {
    ctx.setLocationState([GridState(grid), CarriedItems(carried)]);
    return next();
  };
  const { locationState } = await runMiddleware(remember, { request: "/" });

  expect(locationState).toStrictEqual({
    __rsc_ls_GridState: grid,
    "__rsc_ls_CarriedItems~r": carried,
  });
  expect(locationState).toStrictEqual({
    [GridState.__rsc_ls_key]: grid,
    [CarriedItems.__rsc_ls_key]: carried,
  });
});
