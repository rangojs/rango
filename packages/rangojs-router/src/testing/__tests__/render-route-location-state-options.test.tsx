// @vitest-environment happy-dom
import { Suspense, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import {
  createLocationState,
  useLocationState,
  useParams,
  useRouter,
} from "../../client.js";
import { renderRoute } from "../dom.entry.js";
import { withLocationStateKey } from "../index.js";
import { resolveLocationStateEntries } from "../../browser/react/location-state-shared.js";
import { LoaderRedirect } from "../../loader-redirect.js";

// Userland contract for the createLocationState options of #994 through the
// public primitive. Plain renderRoute() is a client mount (the reader mounts
// during a client navigation); renderRoute({ hydrate: true }) is a document
// load of the entry: it runs production's start-up clearing
// (history-state.ts clearLocationStateOnDocumentLoad) before hydrating. A
// `locationState` seed takes the value the definition is called with;
// renderRoute stores it the way the definition does.

type Grid = { count: number };

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.history.replaceState(null, "");
});

function slot(def: { __rsc_ls_key: string }): unknown {
  return window.history.state?.[def.__rsc_ls_key];
}

describe("renderRoute: createLocationState({ version })", () => {
  const GridV2 = withLocationStateKey(
    createLocationState<Grid>({ version: 2 }),
    "VersionedGrid",
  );
  // The previous deploy's definition: the same slot key, another version.
  const GridV1 = withLocationStateKey(
    createLocationState<{ total: number }>({ version: 1 }),
    "VersionedGrid",
  );
  // The deploy before the definition had a version.
  const GridUnversioned = withLocationStateKey(
    createLocationState<{ total: number }>(),
    "VersionedGrid",
  );

  function Reader() {
    const router = useRouter();
    const grid = useLocationState(GridV2);
    return (
      <div>
        <p data-testid="count">{grid ? grid.count : "none"}</p>
        <button
          data-testid="more"
          onClick={() =>
            router.push("/grid?page=2", {
              state: [GridV2({ count: (grid?.count ?? 0) + 1 })],
            })
          }
        />
      </div>
    );
  }
  const routes = [{ path: "/grid", Component: Reader }];

  it("a seed takes the inner value and is stored as the definition stores it", async () => {
    const { getByTestId } = await renderRoute(routes, {
      locationState: [[GridV2, { count: 3 }]],
    });
    expect(getByTestId("count").textContent).toBe("3");
    expect(slot(GridV2)).toEqual({
      __rsc_ls_env: 1,
      v: 2,
      value: { count: 3 },
    });

    fireEvent.click(getByTestId("more"));
    await waitFor(() => expect(getByTestId("count").textContent).toBe("4"));
    expect(slot(GridV2)).toEqual({
      __rsc_ls_env: 1,
      v: 2,
      value: { count: 4 },
    });
  });

  it("hydrates as the server rendered it, then shows the stored value", async () => {
    const { serverHtml, recoverableErrors, getByTestId } = await renderRoute(
      routes,
      { hydrate: true, locationState: [[GridV2, { count: 3 }]] },
    );
    expect(serverHtml).toContain(">none<");
    expect(recoverableErrors).toEqual([]);
    expect(getByTestId("count").textContent).toBe("3");
    expect(slot(GridV2)).toEqual({
      __rsc_ls_env: 1,
      v: 2,
      value: { count: 3 },
    });
  });

  it.each([
    ["an older version", GridV1],
    ["a definition without a version", GridUnversioned],
  ] as const)(
    "state written by %s reads undefined, on a mount and on a document load",
    async (_label, Older) => {
      const mounted = await renderRoute(routes, {
        locationState: [[Older, { total: 9 }]],
      });
      expect(mounted.getByTestId("count").textContent).toBe("none");
      mounted.unmount();

      const hydrated = await renderRoute(routes, {
        hydrate: true,
        locationState: [[Older, { total: 9 }]],
      });
      expect(hydrated.recoverableErrors).toEqual([]);
      expect(hydrated.getByTestId("count").textContent).toBe("none");
      // The stale slot stays until the next write replaces it.
      expect(slot(GridV2)).toBeDefined();
    },
  );
});

describe("renderRoute: createLocationState({ validate })", () => {
  const isGrid = (value: unknown): value is Grid =>
    typeof (value as Grid | null)?.count === "number";
  const Validated = withLocationStateKey(
    createLocationState<Grid>({ validate: isGrid }),
    "ValidatedGrid",
  );
  const Throwing = withLocationStateKey(
    createLocationState<Grid>({
      validate: (value): value is Grid =>
        (value as { rows: unknown[] }).rows.length > 0,
    }),
    "ThrowingGrid",
  );

  function reader(def: typeof Validated) {
    return function Reader() {
      const grid = useLocationState(def);
      return <p data-testid="count">{grid ? grid.count : "none"}</p>;
    };
  }

  it("stores the raw value and reads it when validate passes", async () => {
    const { getByTestId } = await renderRoute(
      [{ path: "/grid", Component: reader(Validated) }],
      { locationState: [[Validated, { count: 3 }]] },
    );
    expect(getByTestId("count").textContent).toBe("3");
    expect(window.history.state).toEqual({
      __rsc_ls_ValidatedGrid: { count: 3 },
    });
  });

  it("a value that fails validate reads undefined", async () => {
    const { getByTestId } = await renderRoute(
      [{ path: "/grid", Component: reader(Validated) }],
      { locationState: [[Validated, { total: 3 }]] },
    );
    expect(getByTestId("count").textContent).toBe("none");
  });

  it("a validate that throws reads undefined and does not fail the render", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { getByTestId, recoverableErrors } = await renderRoute(
      [{ path: "/grid", Component: reader(Throwing) }],
      { hydrate: true, locationState: [[Throwing, { count: 3 }]] },
    );
    expect(recoverableErrors).toEqual([]);
    expect(getByTestId("count").textContent).toBe("none");
    expect(
      error.mock.calls.filter(([message]) =>
        String(message).includes('"__rsc_ls_ThrowingGrid" threw'),
      ),
    ).toHaveLength(1);
  });
});

describe("renderRoute: createLocationState({ clearOnReload })", () => {
  const Carried = withLocationStateKey(
    createLocationState<string[]>({ clearOnReload: true }),
    "Carried",
  );
  const Sort = withLocationStateKey(
    createLocationState<{ order: string }>(),
    "Sort",
  );
  const CarriedChecked = withLocationStateKey(
    createLocationState<string[]>({
      clearOnReload: true,
      version: 2,
      validate: (value): value is string[] => Array.isArray(value),
    }),
    "CarriedChecked",
  );

  function useCarriedText(def: typeof Carried): string {
    return useLocationState(def)?.join(",") ?? "none";
  }

  // The load-more page: this page's items come from the route (a loader in an
  // app), the pages already on screen are carried as location state.
  function List() {
    const router = useRouter();
    const page = Number(useParams<{ page: string }>().page);
    const carried = useLocationState(Carried) ?? [];
    const sort = useLocationState(Sort);
    const items = [...carried, `p${page}`];
    return (
      <div>
        <p data-testid="items">{items.join(",")}</p>
        <p data-testid="sort">{sort?.order ?? "none"}</p>
        <button
          data-testid="more"
          onClick={() =>
            router.push(`/list/${page + 1}`, { state: [Carried(items)] })
          }
        />
      </div>
    );
  }
  const routes = [{ path: "/list/:page", Component: List }];
  const request = "/list/6";
  const seeds = [
    [Carried, ["p4", "p5"]],
    [Sort, { order: "asc" }],
  ] as const;

  it("a client mount applies the state and stores a marked slot", async () => {
    const { getByTestId } = await renderRoute(routes, {
      request,
      locationState: seeds,
    });
    expect(getByTestId("items").textContent).toBe("p4,p5,p6");
    expect(slot(Carried)).toEqual({
      __rsc_ls_env: 1,
      clearOnReload: true,
      value: ["p4", "p5"],
    });
  });

  it("a document load does not apply it and removes the slot, keeping the others", async () => {
    const { serverHtml, recoverableErrors, getByTestId } = await renderRoute(
      routes,
      { request, hydrate: true, locationState: seeds },
    );
    expect(serverHtml).toContain(">p6<");
    expect(recoverableErrors).toEqual([]);
    expect(getByTestId("items").textContent).toBe("p6");
    expect(getByTestId("sort").textContent).toBe("asc");
    expect(window.history.state).toEqual({ __rsc_ls_Sort: { order: "asc" } });
  });

  it("after a document load, the next client navigation carries state again", async () => {
    const { getByTestId } = await renderRoute(routes, {
      request,
      hydrate: true,
      locationState: seeds,
    });
    expect(getByTestId("items").textContent).toBe("p6");

    fireEvent.click(getByTestId("more"));
    await waitFor(() => expect(getByTestId("items").textContent).toBe("p6,p7"));
    expect(slot(Carried)).toEqual({
      __rsc_ls_env: 1,
      clearOnReload: true,
      value: ["p6"],
    });
  });

  it("popstate and __rsc_locationstate in the running app still apply it", async () => {
    const { getByTestId } = await renderRoute(routes, {
      request,
      hydrate: true,
      locationState: seeds,
    });
    expect(getByTestId("items").textContent).toBe("p6");

    for (const [event, value] of [
      ["popstate", ["p1"]],
      ["__rsc_locationstate", ["p1", "p2"]],
    ] as const) {
      await act(async () => {
        window.history.replaceState(
          { [Carried.__rsc_ls_key]: Carried([...value]).__rsc_ls_value },
          "",
        );
        window.dispatchEvent(new Event(event));
      });
      expect(getByTestId("items").textContent).toBe([...value, "p6"].join(","));
    }
  });

  it("a reader mounted after the document load does not resurrect it", async () => {
    function Late() {
      return <p data-testid="late">{useCarriedText(Carried)}</p>;
    }
    function Toggle() {
      const [shown, setShown] = useState(false);
      return (
        <div>
          <button data-testid="show" onClick={() => setShown(true)} />
          {shown && <Late />}
        </div>
      );
    }
    const { getByTestId, recoverableErrors } = await renderRoute(
      [{ path: "/list", Component: Toggle }],
      { hydrate: true, locationState: [[Carried, ["p4", "p5"]]] },
    );
    expect(slot(Carried)).toBeUndefined();

    fireEvent.click(getByTestId("show"));
    expect(getByTestId("late").textContent).toBe("none");
    expect(recoverableErrors).toEqual([]);
  });

  it("a reader in a Suspense boundary that hydrates after the root stays undefined", async () => {
    function Late() {
      return <p data-testid="late">{useCarriedText(Carried)}</p>;
    }
    function WithBoundary() {
      return (
        <Suspense fallback={<p data-testid="fallback">loading</p>}>
          <Late />
        </Suspense>
      );
    }
    const { getByTestId, recoverableErrors } = await renderRoute(
      [{ path: "/list", Component: WithBoundary }],
      { hydrate: true, locationState: [[Carried, ["p4", "p5"]]] },
    );
    expect(recoverableErrors).toEqual([]);
    expect(getByTestId("late").textContent).toBe("none");
    expect(slot(Carried)).toBeUndefined();
  });

  it("composes with version and validate: decoded on a mount, cleared on a document load", async () => {
    function Checked() {
      return <p data-testid="items">{useCarriedText(CarriedChecked)}</p>;
    }
    const checkedRoutes = [{ path: "/list", Component: Checked }];

    const mounted = await renderRoute(checkedRoutes, {
      locationState: [[CarriedChecked, ["p4"]]],
    });
    expect(mounted.getByTestId("items").textContent).toBe("p4");
    expect(slot(CarriedChecked)).toEqual({
      __rsc_ls_env: 1,
      v: 2,
      clearOnReload: true,
      value: ["p4"],
    });
    mounted.unmount();

    const hydrated = await renderRoute(checkedRoutes, {
      hydrate: true,
      locationState: [[CarriedChecked, ["p4"]]],
    });
    expect(hydrated.recoverableErrors).toEqual([]);
    expect(hydrated.getByTestId("items").textContent).toBe("none");
    expect(slot(CarriedChecked)).toBeUndefined();
  });
});

// State the server produces for the same document load must survive the
// start-up clearing. A document response carries no location state; the one
// lane that delivers some on a document load is a flagged loader's
// redirect(url, { state }), which LoaderRedirect performs from an effect.
describe("renderRoute: clearOnReload and a redirect that carries state on a document load", () => {
  const Carried = withLocationStateKey(
    createLocationState<string[]>({ clearOnReload: true }),
    "RedirectCarried",
  );

  it("drops the entry's stale slot and keeps what the redirect delivers", async () => {
    const delivered = resolveLocationStateEntries([Carried(["fresh"])]);
    const seen: string[] = [];
    function Page() {
      const { page } = useParams<{ page: string }>();
      const carried = useLocationState(Carried)?.join(",") ?? "none";
      seen.push(`${page}:${carried}`);
      return (
        <div>
          <p data-testid="items">{carried}</p>
          {page === "6" && <LoaderRedirect to="/list/7" state={delivered} />}
        </div>
      );
    }

    const { getByTestId, recoverableErrors, router } = await renderRoute(
      [{ path: "/list/:page", Component: Page }],
      {
        request: "/list/6",
        hydrate: true,
        locationState: [[Carried, ["stale"]]],
      },
    );

    await waitFor(() => expect(router.pathname()).toBe("/list/7"));
    await waitFor(() => expect(getByTestId("items").textContent).toBe("fresh"));
    expect(recoverableErrors).toEqual([]);
    expect(seen).not.toContain("6:stale");
    expect(seen).not.toContain("7:stale");
    expect(slot(Carried)).toEqual({
      __rsc_ls_env: 1,
      clearOnReload: true,
      value: ["fresh"],
    });
  });
});

// A definition that sets none of the options: the stored shape and the number
// of renders are what they were before the options existed.
describe("renderRoute: createLocationState() without options is unchanged", () => {
  const Plain = withLocationStateKey(createLocationState<Grid>(), "PlainGrid");
  const Flash = withLocationStateKey(
    createLocationState<Grid>({ flash: true }),
    "FlashGrid",
  );

  it.each([
    // The mount render.
    { hydrate: false, renders: 1 },
    // The server pass, the hydrating render, the client snapshot.
    { hydrate: true, renders: 3 },
  ])(
    "stores the raw value and renders $renders time(s) (hydrate: $hydrate)",
    async ({ hydrate, renders }) => {
      const seen: Array<number | undefined> = [];
      function Reader() {
        const grid = useLocationState(Plain);
        seen.push(grid?.count);
        return <p data-testid="count">{grid?.count ?? "none"}</p>;
      }
      const replaceState = vi.spyOn(window.history, "replaceState");
      const { getByTestId } = await renderRoute(
        [{ path: "/grid", Component: Reader }],
        { hydrate, locationState: [[Plain, { count: 3 }]] },
      );

      expect(getByTestId("count").textContent).toBe("3");
      expect(window.history.state).toEqual({
        __rsc_ls_PlainGrid: { count: 3 },
      });
      // renderRoute's own seed write, and nothing after it.
      expect(replaceState).toHaveBeenCalledTimes(1);
      expect(seen).toHaveLength(renders);
    },
  );

  it("flash state on a document load is shown once and cleared by its reader", async () => {
    function Reader() {
      const grid = useLocationState(Flash);
      return <p data-testid="count">{grid?.count ?? "none"}</p>;
    }
    const { getByTestId, recoverableErrors } = await renderRoute(
      [{ path: "/grid", Component: Reader }],
      { hydrate: true, locationState: [[Flash, { count: 3 }]] },
    );
    expect(recoverableErrors).toEqual([]);
    expect(getByTestId("count").textContent).toBe("3");
    expect(slot(Flash)).toBeUndefined();
  });
});
