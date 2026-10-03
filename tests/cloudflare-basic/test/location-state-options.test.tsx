// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { runMiddleware, withLocationStateKey } from "@rangojs/router/testing";
import { renderRoute } from "@rangojs/router/testing/dom";
import { createLocationState, type Middleware } from "@rangojs/router";
import {
  GridOptionsPanel,
  LoadMoreList,
} from "../src/components/LocationStateOptions.js";
import {
  CarriedItems,
  ListSort,
  ServerPageStamp,
  ValidatedGrid,
  VersionedGrid,
  type GridSnapshot,
} from "../src/location-states.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// Dogfood of the createLocationState options (#994) against cloudflare-basic's
// REAL components and definitions, through the published testing entries. No
// Vite plugin here, so each definition is keyed by name; a definition with
// `version` / `clearOnReload` appends its suffix to that name.
withLocationStateKey(CarriedItems, "CarriedItems");
withLocationStateKey(ListSort, "ListSort");
withLocationStateKey(ServerPageStamp, "ServerPageStamp");
withLocationStateKey(VersionedGrid, "VersionedGrid");
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

it("version and validate: another deploy's state, and a value validate throws on, read as none", async () => {
  // What version 1 of src/location-states.ts#VersionedGrid stored.
  const VersionedGridV1 = withLocationStateKey(
    createLocationState<{ sort: string; page: number }>({ version: 1 }),
    "VersionedGrid",
  );
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const routes = [
    {
      path: "/location-state-grid-options",
      Component: () => (
        <GridOptionsPanel basePath="/location-state-grid-options" />
      ),
    },
  ];

  const current = await renderRoute(routes, {
    locationState: [
      [VersionedGrid, grid],
      [ValidatedGrid, grid],
    ],
  });
  expect(current.getByTestId("vg-value").textContent).toBe("desc:3");
  expect(current.getByTestId("val-value").textContent).toBe("desc:3");
  current.unmount();

  const stale = await renderRoute(routes, {
    hydrate: true,
    locationState: [
      [VersionedGridV1, { sort: "desc", page: 3 }],
      [ValidatedGrid, null],
    ],
  });
  expect(stale.recoverableErrors).toEqual([]);
  expect(stale.getByTestId("vg-value").textContent).toBe("none");
  expect(stale.getByTestId("val-value").textContent).toBe("none");
  expect(error).toHaveBeenCalledWith(
    expect.stringContaining('"__rsc_ls_ValidatedGrid" threw'),
    expect.any(TypeError),
  );
});

it("a middleware's state is keyed by the definition's key, options included", async () => {
  const remember: Middleware = async (ctx, next) => {
    ctx.setLocationState([VersionedGrid(grid), CarriedItems(carried)]);
    return next();
  };
  const { locationState } = await runMiddleware(remember, { request: "/" });

  expect(locationState).toEqual({
    "__rsc_ls_VersionedGrid~v2": grid,
    "__rsc_ls_CarriedItems~r": carried,
  });
  expect(locationState).toEqual({
    [VersionedGrid.__rsc_ls_key]: grid,
    [CarriedItems.__rsc_ls_key]: carried,
  });
});
