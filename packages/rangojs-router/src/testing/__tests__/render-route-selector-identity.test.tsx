// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Suspense, useLayoutEffect, type ReactNode } from "react";
import { act, cleanup, waitFor } from "@testing-library/react";
import { Outlet } from "../../client.js";
import { useNavigation } from "../../browser/react/use-navigation.js";
import { useLoader } from "../../use-loader.js";
import type { LoaderDefinition } from "../../types.js";
import { renderRoute } from "../render-route.js";
import { installViewTransitionStub } from "@shared/e2e/view-transition-stub";

// Consumer contract: a selector that returns the location object itself
// (`useNavigation((nav) => nav.location)`) follows the page the way
// `nav.location.href` does. A URL has no own enumerable keys, so the selector
// equality (browser/react/shallow-equal.ts) compares it by identity, not by
// keys: before that, any two URLs compared equal and the reader kept the URL
// it first rendered, for the life of the component.
//
// Every case here navigates within one path (a search change), which is where
// a reader stays mounted: renderRoute renders a new page tree when the path
// changes, so a component there takes its value from the hook's initializer
// and never shows the defect.
//
// The other half of the contract is what must not change: a notification that
// leaves the location where it is renders the reader not at all, and the full
// state (`useNavigation()`) and a primitive selector keep their behavior.

const ItemLoader = {
  __brand: "loader",
} as unknown as LoaderDefinition<string>;

let renders: number;
let stub: ReturnType<typeof installViewTransitionStub> | undefined;

// Reads the loader so a navigation whose loader the test holds suspends, as
// the page's own reader does.
function LocationReader(): ReactNode {
  const location = useNavigation((nav) => nav.location);
  useLoader(ItemLoader);
  useLayoutEffect(() => {
    renders += 1;
  });
  return (
    <p data-testid="location">{`${location.pathname}${location.search}`}</p>
  );
}

function Shell(): ReactNode {
  return (
    <Suspense fallback={<p data-testid="skeleton">skeleton</p>}>
      <Outlet />
    </Suspense>
  );
}

beforeEach(() => {
  renders = 0;
  stub = undefined;
});

afterEach(() => {
  cleanup();
  stub?.uninstall();
});

describe.each([
  {
    variant: "transition() route, view transitions supported",
    transition: true,
    vt: true,
  },
  {
    variant: "transition() route, view transitions unsupported",
    transition: true,
    vt: false,
  },
  {
    variant: "no transition(), urgent commit",
    transition: false,
    vt: false,
  },
])(
  "renderRoute: useNavigation((nav) => nav.location) follows the page ($variant)",
  ({ transition, vt }) => {
    it("shows the destination's URL once its page shows, and the page on screen's while it is held", async () => {
      if (vt) stub = installViewTransitionStub();

      const { getByTestId, router } = await renderRoute(
        [
          { path: "/items", Component: Shell },
          {
            path: "/items",
            Component: LocationReader,
            ...(transition && { transition: {} }),
          },
        ],
        { request: "/items?page=1", loaders: [[ItemLoader, "1"]] },
      );
      const location = () => getByTestId("location").textContent;
      expect(location()).toBe("/items?page=1");

      let resolve!: (data: string) => void;
      const next = new Promise<string>((r) => (resolve = r));
      await router.navigate("/items?page=2", { loaders: [[ItemLoader, next]] });
      if (transition) {
        // React holds the destination: the page on screen keeps its URL.
        expect(location()).toBe("/items?page=1");
      }

      await act(async () => {
        resolve("2");
        await next;
      });
      await waitFor(() => expect(location()).toBe("/items?page=2"));
    });
  },
);

describe("renderRoute: useNavigation selector equality", () => {
  it("a notification that leaves the location where it is renders the URL reader not at all", async () => {
    const { getByTestId, router } = await renderRoute(
      [{ path: "/items", Component: LocationReader }],
      { request: "/items", loaders: [[ItemLoader, "1"]] },
    );
    expect(getByTestId("location").textContent).toBe("/items");
    const rendersAfterMount = renders;

    // A server action reports loading and idle without moving the page.
    let action!: ReturnType<typeof router.eventController.startAction>;
    await act(async () => {
      action = router.eventController.startAction("src/actions.ts#save", []);
    });
    expect(renders).toBe(rendersAfterMount);
    await act(async () => {
      action[Symbol.dispose]();
    });
    expect(renders).toBe(rendersAfterMount);
    expect(getByTestId("location").textContent).toBe("/items");
  });

  it("a back onto the previous entry moves the URL reader back with it", async () => {
    const { getByTestId, router } = await renderRoute(
      [{ path: "/items", Component: LocationReader }],
      { request: "/items?page=1", loaders: [[ItemLoader, "1"]] },
    );
    const location = () => getByTestId("location").textContent;
    expect(location()).toBe("/items?page=1");
    const mountedEntry = window.history.state;

    // A navigation that writes a history entry, as a push does.
    await act(async () => {
      await router.navigate("/items?page=2", {
        state: { from: "list" },
        loaders: [[ItemLoader, "2"]],
      });
    });
    expect(location()).toBe("/items?page=2");

    // Back onto the entry the mount wrote, the way a traversal hands it over.
    await act(async () => {
      window.history.replaceState(mountedEntry, "");
      window.dispatchEvent(new Event("popstate"));
    });
    await waitFor(() => expect(location()).toBe("/items?page=1"));
  });

  it("the full state and a primitive selector read the same page as the URL selector", async () => {
    function MixedReader(): ReactNode {
      const full = useNavigation();
      const href = useNavigation((nav) => nav.location.href);
      const location = useNavigation((nav) => nav.location);
      return (
        <p data-testid="mixed">
          {`${full.location.pathname}${full.location.search}|${new URL(href).pathname}${new URL(href).search}|${location.pathname}${location.search}`}
        </p>
      );
    }
    const { getByTestId, router } = await renderRoute(
      [{ path: "/items", Component: MixedReader }],
      { request: "/items?page=1", loaders: [[ItemLoader, "1"]] },
    );
    const read = () => getByTestId("mixed").textContent;
    expect(read()).toBe("/items?page=1|/items?page=1|/items?page=1");

    await act(async () => {
      await router.navigate("/items?page=2", { loaders: [[ItemLoader, "2"]] });
    });
    expect(read()).toBe("/items?page=2|/items?page=2|/items?page=2");
  });
});
