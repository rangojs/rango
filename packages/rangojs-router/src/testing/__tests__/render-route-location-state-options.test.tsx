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

// Userland contract for createLocationState({ clearOnReload }) (#994) through
// the public primitive. Plain renderRoute() is a client mount (the reader
// mounts during a client navigation); renderRoute({ hydrate: true }) is a
// document load of the seeded entry: it runs production's start-up step
// (history-state.ts clearLocationStateOnDocumentLoad) before hydrating.
//
// A seed is `[definition, value]` and lands under the definition's own key.
// The app version of location state is covered in
// location-state-version.test.tsx.

type Grid = { count: number };

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.history.replaceState(null, "");
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

  function useCarriedText(): string {
    return useLocationState(Carried)?.join(",") ?? "none";
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

  it("a client mount applies the state", async () => {
    const { getByTestId } = await renderRoute(routes, {
      request,
      locationState: seeds,
    });
    expect(getByTestId("items").textContent).toBe("p4,p5,p6");
    expect(window.history.state).toEqual({
      "__rsc_ls_Carried~r": ["p4", "p5"],
      __rsc_ls_Sort: { order: "asc" },
    });
  });

  it("a document load does not apply it and removes the slot; the next navigation carries again", async () => {
    const { serverHtml, recoverableErrors, getByTestId } = await renderRoute(
      routes,
      { request, hydrate: true, locationState: seeds },
    );
    expect(serverHtml).toContain(">p6<");
    expect(recoverableErrors).toEqual([]);
    expect(getByTestId("items").textContent).toBe("p6");
    expect(getByTestId("sort").textContent).toBe("asc");
    expect(window.history.state).toEqual({ __rsc_ls_Sort: { order: "asc" } });

    fireEvent.click(getByTestId("more"));
    await waitFor(() => expect(getByTestId("items").textContent).toBe("p6,p7"));
    expect(Carried.read()).toEqual(["p6"]);
  });

  it("back/forward in the running app still applies it", async () => {
    const { getByTestId } = await renderRoute(routes, {
      request,
      hydrate: true,
      locationState: seeds,
    });
    expect(getByTestId("items").textContent).toBe("p6");

    await act(async () => {
      window.history.replaceState({ [Carried.__rsc_ls_key]: ["p1"] }, "");
      window.dispatchEvent(new Event("popstate"));
    });
    expect(getByTestId("items").textContent).toBe("p1,p6");
  });

  it("a reader that mounts later, or hydrates in a late Suspense boundary, does not resurrect it", async () => {
    function Reader({ id }: { id: string }) {
      return <p data-testid={id}>{useCarriedText()}</p>;
    }
    function Page() {
      const [shown, setShown] = useState(false);
      return (
        <div>
          <Suspense fallback={null}>
            <Reader id="boundary" />
          </Suspense>
          <button data-testid="show" onClick={() => setShown(true)} />
          {shown && <Reader id="late" />}
        </div>
      );
    }
    const { getByTestId, recoverableErrors } = await renderRoute(
      [{ path: "/list", Component: Page }],
      { hydrate: true, locationState: [[Carried, ["p4", "p5"]]] },
    );
    expect(getByTestId("boundary").textContent).toBe("none");

    fireEvent.click(getByTestId("show"));
    expect(getByTestId("late").textContent).toBe("none");
    expect(recoverableErrors).toEqual([]);
  });

  // State the server produces for the same document load must survive. A
  // document response carries none; the one lane that delivers some on a
  // document load is a flagged loader's redirect(url, { state }), which
  // LoaderRedirect performs from an effect.
  it("keeps the state a loader redirect delivers on the same document load", async () => {
    const delivered = resolveLocationStateEntries([Carried(["fresh"])]);
    const seen: string[] = [];
    function Page() {
      const { page } = useParams<{ page: string }>();
      const carried = useCarriedText();
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
      { request, hydrate: true, locationState: [[Carried, ["stale"]]] },
    );

    await waitFor(() => expect(router.pathname()).toBe("/list/7"));
    await waitFor(() => expect(getByTestId("items").textContent).toBe("fresh"));
    expect(recoverableErrors).toEqual([]);
    expect(seen.filter((entry) => entry.endsWith(":stale"))).toEqual([]);
    expect(Carried.read()).toEqual(["fresh"]);
  });

  it("a slot stored before the definition adopted the option is not read, and not removed", async () => {
    const BeforeAdoption = withLocationStateKey(
      createLocationState<string[]>(),
      "Carried",
    );
    const { getByTestId } = await renderRoute(routes, {
      request,
      hydrate: true,
      locationState: [[BeforeAdoption, ["p1"]]],
    });
    expect(getByTestId("items").textContent).toBe("p6");
    expect(window.history.state).toEqual({ __rsc_ls_Carried: ["p1"] });
  });
});

// A definition without `clearOnReload`: the stored key and value and the
// number of renders are what they were before the option existed (this
// describe passes on main's runtime too).
describe("renderRoute: a definition without clearOnReload is unchanged", () => {
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
    "stores the raw value under the injected key and renders $renders time(s) (hydrate: $hydrate)",
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
      expect(Plain.__rsc_ls_key).toBe("__rsc_ls_PlainGrid");
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
    expect(window.history.state).not.toHaveProperty("__rsc_ls_FlashGrid");
  });
});
