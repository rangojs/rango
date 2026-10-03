// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
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
// Vite plugin here: the names below are also what an older definition of the
// same slot is keyed onto.
withLocationStateKey(CarriedItems, "CarriedItems");
withLocationStateKey(ListSort, "ListSort");
withLocationStateKey(ServerPageStamp, "ServerPageStamp");
withLocationStateKey(VersionedGrid, "VersionedGrid");
withLocationStateKey(ValidatedGrid, "ValidatedGrid");

function LoadMorePage() {
  return (
    <LoadMoreList
      basePath="/location-state-load-more"
      page={2}
      items={["p2-1", "p2-2", "p2-3"]}
    />
  );
}
const loadMoreRoutes = [
  { path: "/location-state-load-more", Component: LoadMorePage },
];
const carried = ["p1-1", "p1-2", "p1-3"];
const loadMoreSeeds = [
  [CarriedItems, carried],
  [ListSort, { order: "asc" }],
] as const;

describe("clearOnReload (cloudflare-basic)", () => {
  it("a client mount shows the carried items above the page's own", async () => {
    const { getByTestId, getAllByRole } = await renderRoute(loadMoreRoutes, {
      locationState: loadMoreSeeds,
    });
    expect(getByTestId("lm-carried-count").textContent).toBe("3");
    expect(getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      ...carried,
      "p2-1",
      "p2-2",
      "p2-3",
    ]);
  });

  it("a document load shows the page as the server rendered it and removes the slot", async () => {
    const { serverHtml, recoverableErrors, getByTestId, getAllByRole } =
      await renderRoute(loadMoreRoutes, {
        hydrate: true,
        locationState: loadMoreSeeds,
      });
    expect(serverHtml).not.toContain("p1-1");
    expect(recoverableErrors).toEqual([]);
    expect(getByTestId("lm-sort").textContent).toBe("asc");
    expect(getByTestId("lm-carried-count").textContent).toBe("0");
    expect(getAllByRole("listitem")).toHaveLength(3);
    expect(CarriedItems.read()).toBeUndefined();
    expect(window.history.state).toEqual({
      __rsc_ls_ListSort: { order: "asc" },
    });

    // "Load more" carries the items on screen again.
    fireEvent.click(getByTestId("lm-more"));
    await waitFor(() =>
      expect(CarriedItems.read()).toEqual(["p2-1", "p2-2", "p2-3"]),
    );
  });
});

describe("version and validate (cloudflare-basic)", () => {
  // What an earlier deploy of src/location-states.ts stored under the same key.
  const VersionedGridV1 = withLocationStateKey(
    createLocationState<{ sort: string; page: number }>({ version: 1 }),
    "VersionedGrid",
  );
  function GridPage() {
    return <GridOptionsPanel basePath="/location-state-grid-options" />;
  }
  const gridRoutes = [
    { path: "/location-state-grid-options", Component: GridPage },
  ];
  const grid: GridSnapshot = { order: "desc", page: 3 };

  it("reads its own state", async () => {
    const { getByTestId } = await renderRoute(gridRoutes, {
      locationState: [
        [VersionedGrid, grid],
        [ValidatedGrid, grid],
      ],
    });
    expect(getByTestId("vg-value").textContent).toBe("desc:3");
    expect(getByTestId("val-value").textContent).toBe("desc:3");
  });

  it("reads state from an older version, and a value validate throws on, as none", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { getByTestId, recoverableErrors } = await renderRoute(gridRoutes, {
      hydrate: true,
      locationState: [
        [VersionedGridV1, { sort: "desc", page: 3 }],
        [ValidatedGrid, null],
      ],
    });
    expect(recoverableErrors).toEqual([]);
    expect(getByTestId("vg-value").textContent).toBe("none");
    expect(getByTestId("val-value").textContent).toBe("none");
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('"__rsc_ls_ValidatedGrid" threw'),
      expect.any(TypeError),
    );
  });

  it("a middleware's versioned state is asserted through the definition", async () => {
    const remember: Middleware = async (ctx, next) => {
      ctx.setLocationState([VersionedGrid(grid), CarriedItems(carried)]);
      return next();
    };
    const { locationState } = await runMiddleware(remember, { request: "/" });

    expect(VersionedGrid.read({ state: locationState })).toEqual(grid);
    expect(CarriedItems.read({ state: locationState })).toEqual(carried);
    expect(VersionedGridV1.read({ state: locationState })).toBeUndefined();
  });
});
