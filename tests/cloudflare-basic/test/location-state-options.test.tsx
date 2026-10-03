// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { runMiddleware, withLocationStateKey } from "@rangojs/router/testing";
import { renderRoute } from "@rangojs/router/testing/dom";
import type { Middleware } from "@rangojs/router";
import {
  GridOptionsPanel,
  LoadMoreList,
} from "../src/components/LocationStateOptions.js";
import {
  CarriedItems,
  GridState,
  ListSort,
  ServerPageStamp,
  ValidatedGrid,
  type GridSnapshot,
} from "../src/location-states.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// Dogfood of location state's options and its app version (#994) against
// cloudflare-basic's REAL components and definitions, through the published
// testing entries. No Vite plugin here, so each definition is keyed by name; a
// definition with `clearOnReload` appends its suffix to that name.
withLocationStateKey(CarriedItems, "CarriedItems");
withLocationStateKey(ListSort, "ListSort");
withLocationStateKey(ServerPageStamp, "ServerPageStamp");
withLocationStateKey(GridState, "GridState");
withLocationStateKey(ValidatedGrid, "ValidatedGrid");

const carried = ["p1-1", "p1-2", "p1-3"];
const grid: GridSnapshot = { order: "desc", page: 3 };

function LoadMorePage() {
  return (
    <LoadMoreList
      basePath="/location-state-load-more"
      page={2}
      items={["p2-1", "p2-2", "p2-3"]}
    />
  );
}
const loadMore = {
  routes: [{ path: "/location-state-load-more", Component: LoadMorePage }],
  locationState: [
    [CarriedItems, carried],
    [ListSort, { order: "asc" }],
  ] as const,
};

it("clearOnReload: a client mount shows the carried items, a document load does not", async () => {
  const mounted = await renderRoute(loadMore.routes, {
    locationState: loadMore.locationState,
  });
  expect(
    mounted.getAllByRole("listitem").map((item) => item.textContent),
  ).toEqual([...carried, "p2-1", "p2-2", "p2-3"]);
  mounted.unmount();

  const loaded = await renderRoute(loadMore.routes, {
    hydrate: true,
    locationState: loadMore.locationState,
  });
  expect(loaded.serverHtml).not.toContain("p1-1");
  expect(loaded.recoverableErrors).toEqual([]);
  expect(loaded.getByTestId("lm-sort").textContent).toBe("asc");
  expect(loaded.getAllByRole("listitem")).toHaveLength(3);
  expect(window.history.state).toEqual({ __rsc_ls_ListSort: { order: "asc" } });

  // "Load more" carries the items on screen again.
  fireEvent.click(loaded.getByTestId("lm-more"));
  await waitFor(() =>
    expect(CarriedItems.read()).toEqual(["p2-1", "p2-2", "p2-3"]),
  );
});

const gridRoutes = [
  {
    path: "/location-state-grid-options",
    Component: () => (
      <GridOptionsPanel basePath="/location-state-grid-options" step="start" />
    ),
  },
];

// The app version location state is recorded under never shows up in a test:
// a seed is a definition and a value, and it reads back on a mount and on a
// document load.
it("the app version: seeds read back without one; an entry another version wrote does not", async () => {
  const seeds = [[GridState, grid]] as const;
  const mounted = await renderRoute(gridRoutes, { locationState: seeds });
  expect(mounted.getByTestId("grid-value").textContent).toBe("desc:3");
  expect(window.history.state).toEqual({ __rsc_ls_GridState: grid });
  mounted.unmount();

  const loaded = await renderRoute(gridRoutes, {
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

it("validate: a value the guard throws on reads as none", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});

  const accepted = await renderRoute(gridRoutes, {
    locationState: [[ValidatedGrid, grid]],
  });
  expect(accepted.getByTestId("val-value").textContent).toBe("desc:3");
  accepted.unmount();

  const rejected = await renderRoute(gridRoutes, {
    hydrate: true,
    locationState: [
      [GridState, grid],
      [ValidatedGrid, null],
    ],
  });
  expect(rejected.recoverableErrors).toEqual([]);
  expect(rejected.getByTestId("grid-value").textContent).toBe("desc:3");
  expect(rejected.getByTestId("val-value").textContent).toBe("none");
  expect(error).toHaveBeenCalledWith(
    expect.stringContaining('"__rsc_ls_ValidatedGrid" threw'),
    expect.any(TypeError),
  );
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
