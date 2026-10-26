// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Suspense, useLayoutEffect, type ReactNode } from "react";
import { act, cleanup, waitFor } from "@testing-library/react";
import { createLocationState, Outlet } from "../../client.js";
import { useNavigation } from "../../browser/react/use-navigation.js";
import { useSearchParams } from "../../browser/react/use-search-params.js";
import { useLoader } from "../../use-loader.js";
import { emitNetworkError } from "../../browser/network-error-handler.js";
import { NetworkError } from "../../errors.js";
import type { LoaderDefinition } from "../../types.js";
import { renderRoute } from "../render-route.js";
import { installViewTransitionStub } from "@shared/e2e/view-transition-stub";

// Consumer contract (#1164): a component that reads useNavigation() and
// useSearchParams() never renders "navigation finished, URL unchanged" on a
// same-route search navigation, whether the commit runs as a view transition,
// in a transition() route where the browser has none, or urgently.
// renderRoute holds a navigate() commit only for a transition() route; the
// same-structure hold of a route without transition() is not modeled (it
// commits urgently here).

const TagsLoader = { __brand: "loader" } as unknown as LoaderDefinition<
  string[]
>;

let log: string[];
let stub: ReturnType<typeof installViewTransitionStub> | undefined;

function Filters(): ReactNode {
  const idle = useNavigation((nav) => nav.state === "idle");
  const [search] = useSearchParams();
  const { data } = useLoader(TagsLoader);
  const entry = `${idle ? "idle" : "loading"} ${search} [${data.join(",")}]`;
  log.push(entry);
  return <p data-testid="filters">{entry}</p>;
}

function Shell(): ReactNode {
  return (
    <Suspense fallback={<p data-testid="skeleton">skeleton</p>}>
      <Outlet />
    </Suspense>
  );
}

beforeEach(() => {
  log = [];
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
  "renderRoute: useNavigation() idle commits with useSearchParams() ($variant)",
  ({ transition, vt }) => {
    it("a search navigation whose loader is pending never shows idle with the old search", async () => {
      if (vt) stub = installViewTransitionStub();
      expect("startViewTransition" in document).toBe(vt);

      const { getByTestId, queryByTestId, router } = await renderRoute(
        [
          { path: "/products", Component: Shell },
          {
            path: "/products",
            Component: Filters,
            ...(transition && { transition: {} }),
          },
        ],
        {
          request: "/products?tag=a&tag=b",
          loaders: [[TagsLoader, ["a", "b"]]],
        },
      );
      expect(getByTestId("filters").textContent).toBe("idle tag=a&tag=b [a,b]");

      let resolve!: (tags: string[]) => void;
      const next = new Promise<string[]>((r) => (resolve = r));
      await router.navigate("/products?tag=b", {
        loaders: [[TagsLoader, next]],
      });
      if (transition) {
        // React holds the destination: the page being left, still loading.
        expect(getByTestId("filters").textContent).toBe(
          "loading tag=a&tag=b [a,b]",
        );
      } else {
        expect(queryByTestId("skeleton")).not.toBeNull();
      }

      await act(async () => {
        resolve(["b"]);
        await next;
      });
      await waitFor(() =>
        expect(getByTestId("filters").textContent).toBe("idle tag=b [b]"),
      );

      const sinceStart = log
        .slice(log.indexOf("loading tag=a&tag=b [a,b]"))
        .filter((v, i, all) => all[i - 1] !== v);
      expect(sinceStart).toEqual([
        "loading tag=a&tag=b [a,b]",
        "idle tag=b [b]",
      ]);
      expect((stub?.started() ?? 0) > 0).toBe(vt);
    });
  },
);

// Hook-lock row S8: a newer navigation that ends with no page while React
// holds a page. In production the server answers it with an external
// redirect, a redirect payload the client blocks, or a router reload (the
// e2e nav-idle-overlap suite covers the external redirect);
// through renderRoute the reachable form is a push whose state the dev check
// refuses, which throws before it commits. idle stays off screen until the
// held page commits with its search.
const Bad = createLocationState<{ n: number }>();

describe.each([
  { variant: "view transitions supported", vt: true },
  { variant: "view transitions unsupported", vt: false },
])(
  "renderRoute: a newer navigation that ends with no page while a transition() page is held ($variant)",
  ({ vt }) => {
    it("never shows idle with the old search", async () => {
      if (vt) stub = installViewTransitionStub();

      const { getByTestId, router } = await renderRoute(
        [
          { path: "/products", Component: Shell },
          { path: "/products", Component: Filters, transition: {} },
        ],
        {
          request: "/products?tag=a&tag=b",
          loaders: [[TagsLoader, ["a", "b"]]],
        },
      );

      let resolve!: (tags: string[]) => void;
      const next = new Promise<string[]>((r) => (resolve = r));
      await router.navigate("/products?tag=b", {
        loaders: [[TagsLoader, next]],
      });
      expect(getByTestId("filters").textContent).toBe(
        "loading tag=a&tag=b [a,b]",
      );

      // The newer navigation starts (loading) and throws before its commit;
      // its end is delivered on the controller's next task. Inside an awaited
      // act: navigate() flushes its start in a sync act(), and the held page
      // React re-renders there would not be retried once its loader settles.
      await act(async () => {
        await expect(
          router.navigate("/products?tag=c", { state: Bad as never }),
        ).rejects.toThrow(/location-state definition/);
        await new Promise((r) => setTimeout(r, 0));
      });
      expect(getByTestId("filters").textContent).toBe(
        "loading tag=a&tag=b [a,b]",
      );

      await act(async () => {
        resolve(["b"]);
        await next;
      });
      await waitFor(() =>
        expect(getByTestId("filters").textContent).toBe("idle tag=b [b]"),
      );
      // The page commits with the newer click's loading, which React rebases
      // over it; its release brings idle in the commit's task.
      const sinceStart = log
        .slice(log.indexOf("loading tag=a&tag=b [a,b]"))
        .filter((v, i, all) => all[i - 1] !== v);
      expect(sinceStart).not.toContain("idle tag=a&tag=b [a,b]");
      expect(sinceStart).toEqual([
        "loading tag=a&tag=b [a,b]",
        "loading tag=b [b]",
        "idle tag=b [b]",
      ]);
    });
  },
);

// A newer navigation that fails while React holds a page: the bridge hands
// the root error screen over in a transition (navigation-bridge.ts
// navigate(), emitNetworkError), then disposes the navigation. That
// hand-over anchors like a page, so idle waits for the error screen and
// never lands on the page being left with its search. The error screen
// replaces the reader, so the pin is that no frame before it shows idle.
describe.each([
  { variant: "view transitions supported", vt: true },
  { variant: "view transitions unsupported", vt: false },
])(
  "renderRoute: a newer navigation that fails while a transition() page is held ($variant)",
  ({ vt }) => {
    it("never shows idle with the old search before the error screen", async () => {
      if (vt) stub = installViewTransitionStub();

      const { getByTestId, queryByTestId, queryByText, router } =
        await renderRoute(
          [
            { path: "/products", Component: Shell },
            { path: "/products", Component: Filters, transition: {} },
          ],
          {
            request: "/products?tag=a&tag=b",
            loaders: [[TagsLoader, ["a", "b"]]],
          },
        );

      const next = new Promise<string[]>(() => {});
      await router.navigate("/products?tag=b", {
        loaders: [[TagsLoader, next]],
      });
      expect(getByTestId("filters").textContent).toBe(
        "loading tag=a&tag=b [a,b]",
      );

      const newer = router.eventController.startNavigation(
        "http://localhost/products?tag=c",
      );
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
      await act(async () => {
        emitNetworkError(
          (update) => router.store.emitUpdate(update),
          new NetworkError("offline", { url: "/products?tag=c" }),
          "/products",
        );
        newer[Symbol.dispose]();
        await new Promise((r) => setTimeout(r, 0));
      });
      await waitFor(() =>
        expect(queryByText("Connection Error")).not.toBeNull(),
      );
      expect(queryByTestId("filters")).toBeNull();
      expect(router.eventController.getState().state).toBe("idle");

      const sinceStart = log
        .slice(log.indexOf("loading tag=a&tag=b [a,b]"))
        .filter((v, i, all) => all[i - 1] !== v);
      expect(sinceStart).toEqual(["loading tag=a&tag=b [a,b]"]);
    });
  },
);

// Hook-lock row S10: a server action that settles while React holds a page.
// renderRoute has no action primitive; the router's server-action bridge
// drives the controller this way (startAction, complete, then dispose in its
// finally). In the browser an action that also starts during the hold
// settles only after the held content (its commit awaits it), so the e2e
// pins the action already in flight at the click; here both orders are
// pinned on the hook.
const SAVE = "src/actions.ts#save";

/** The full state's pendingUrl, as its search. */
function FullFilters(): ReactNode {
  const nav = useNavigation();
  const [search] = useSearchParams();
  const { data } = useLoader(TagsLoader);
  const pending = nav.pendingUrl ? new URL(nav.pendingUrl).search : "-";
  const entry = `${nav.state} pu=${pending} ${search} [${data.join(",")}]`;
  log.push(entry);
  return <p data-testid="filters">{entry}</p>;
}

/** A task, then the action's 100 ms settle window, inside an awaited act. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 150));
  });
}

function deferredTags(): {
  promise: Promise<string[]>;
  resolve: (tags: string[]) => void;
} {
  let resolve!: (tags: string[]) => void;
  const promise = new Promise<string[]>((r) => (resolve = r));
  return { promise, resolve };
}

describe.each([
  { variant: "view transitions supported", vt: true },
  { variant: "view transitions unsupported", vt: false },
])(
  "renderRoute: a server action while a transition() page is held ($variant)",
  ({ vt }) => {
    async function mount(Component: () => ReactNode) {
      if (vt) stub = installViewTransitionStub();
      return renderRoute(
        [
          { path: "/products", Component: Shell },
          { path: "/products", Component, transition: {} },
        ],
        {
          request: "/products?tag=a&tag=b",
          loaders: [[TagsLoader, ["a", "b"]]],
        },
      );
    }

    function sinceLoading(): string[] {
      return log
        .slice(log.findIndex((e) => e.startsWith("loading")))
        .filter((v, i, all) => all[i - 1] !== v);
    }

    it("an action in flight at the click that settles during the hold never shows idle with the old search", async () => {
      const { getByTestId, router } = await mount(Filters);
      const action = router.eventController.startAction(SAVE, []);
      await settle();

      const next = deferredTags();
      await act(async () => {
        await router.navigate("/products?tag=b", {
          loaders: [[TagsLoader, next.promise]],
        });
      });
      action.complete(undefined);
      action[Symbol.dispose]();
      await settle();
      expect(getByTestId("filters").textContent).toBe(
        "loading tag=a&tag=b [a,b]",
      );

      await act(async () => {
        next.resolve(["b"]);
        await next.promise;
      });
      await waitFor(() =>
        expect(getByTestId("filters").textContent).toBe("idle tag=b [b]"),
      );
      expect(sinceLoading()).not.toContain("idle tag=a&tag=b [a,b]");
    });

    it("an action that starts and settles during the hold never shows idle with the old search", async () => {
      const { getByTestId, router } = await mount(Filters);
      const next = deferredTags();
      await router.navigate("/products?tag=b", {
        loaders: [[TagsLoader, next.promise]],
      });

      const action = router.eventController.startAction(SAVE, []);
      await settle();
      action.complete(undefined);
      action[Symbol.dispose]();
      await settle();
      expect(getByTestId("filters").textContent).toBe(
        "loading tag=a&tag=b [a,b]",
      );

      await act(async () => {
        next.resolve(["b"]);
        await next.promise;
      });
      await waitFor(() =>
        expect(getByTestId("filters").textContent).toBe("idle tag=b [b]"),
      );
      expect(sinceLoading()).not.toContain("idle tag=a&tag=b [a,b]");
    });

    it.each([
      { when: "after the action settled", settled: true },
      { when: "while the action still runs", settled: false },
    ])(
      "$when, a newer click's pendingUrl shows at once over the held page",
      async ({ settled }) => {
        const { getByTestId, router } = await mount(FullFilters);
        const action = router.eventController.startAction(SAVE, []);
        await settle();

        const next = deferredTags();
        await act(async () => {
          await router.navigate("/products?tag=b", {
            loaders: [[TagsLoader, next.promise]],
          });
        });
        if (settled) {
          action.complete(undefined);
          action[Symbol.dispose]();
          await settle();
        }

        const newer = deferredTags();
        await act(async () => {
          await router.navigate("/products?tag=c", {
            loaders: [[TagsLoader, newer.promise]],
          });
        });
        // The click's own notification, delivered at once over the old page,
        // which stays on screen while React holds both pages.
        expect(getByTestId("filters").textContent).toBe(
          "loading pu=?tag=c tag=a&tag=b [a,b]",
        );

        if (!settled) {
          action.complete(undefined);
          action[Symbol.dispose]();
          await settle();
        }
        await act(async () => {
          next.resolve(["b"]);
          newer.resolve(["c"]);
          await Promise.all([next.promise, newer.promise]);
        });
        await waitFor(() =>
          expect(getByTestId("filters").textContent).toBe(
            "idle pu=- tag=c [c]",
          ),
        );
        expect(sinceLoading().filter((e) => e.startsWith("idle"))).toEqual([
          "idle pu=- tag=c [c]",
        ]);
      },
    );
  },
);

// Hook-lock row L2: useNavigation().location is the page on screen until the
// next page shows; pendingUrl is the page being fetched. A newer click while
// React holds a transition() page delivers its loading and pendingUrl at once,
// without the held page's location: that page is not on screen and, once the
// newer page replaces it, never will be.
const ItemLoader = { __brand: "loader" } as unknown as LoaderDefinition<string>;

let commits: string[];

function Item(): ReactNode {
  const { data } = useLoader(ItemLoader);
  return <p data-testid="item">{data}</p>;
}

const pathOf = (url: string | null): string =>
  url ? new URL(url).pathname : "-";

/** The full state, and selectors of location alone and pendingUrl alone. */
function NavStatus(): ReactNode {
  const nav = useNavigation();
  const location = useNavigation((n) => n.location.href);
  const pendingUrl = useNavigation((n) => n.pendingUrl);
  const entry =
    `${nav.state} location=${nav.location.pathname} pendingUrl=${pathOf(nav.pendingUrl)}` +
    ` | location=${pathOf(location)} pendingUrl=${pathOf(pendingUrl)}`;
  useLayoutEffect(() => {
    const item = document.querySelector('[data-testid="item"]');
    commits.push(`page ${item?.textContent ?? "-"}: ${entry}`);
  });
  return <p data-testid="nav">{entry}</p>;
}

function ItemsShell(): ReactNode {
  return (
    <>
      <NavStatus />
      <Suspense fallback={<p data-testid="skeleton">skeleton</p>}>
        <Outlet />
      </Suspense>
    </>
  );
}

function deferredItem(): {
  promise: Promise<string>;
  resolve: (id: string) => void;
} {
  let resolve!: (id: string) => void;
  const promise = new Promise<string>((r) => (resolve = r));
  return { promise, resolve };
}

describe.each([
  { variant: "view transitions supported", vt: true },
  { variant: "view transitions unsupported", vt: false },
])(
  "renderRoute: useNavigation().location while a newer click waits on a held transition() page ($variant)",
  ({ vt }) => {
    async function mount() {
      if (vt) stub = installViewTransitionStub();
      commits = [];
      const rendered = await renderRoute(
        [
          { path: "/items/:id", Component: ItemsShell },
          { path: "/items/:id", Component: Item, transition: {} },
        ],
        { request: "/items/1", loaders: [[ItemLoader, "1"]] },
      );
      const second = deferredItem();
      await rendered.router.navigate("/items/2", {
        loaders: [[ItemLoader, second.promise]],
      });
      // React holds page 2.
      expect(rendered.getByTestId("item").textContent).toBe("1");
      expect(rendered.getByTestId("nav").textContent).toBe(
        "loading location=/items/1 pendingUrl=/items/2 | location=/items/1 pendingUrl=/items/2",
      );
      return { ...rendered, second };
    }

    /** Commits whose location, full state or selector, is not the page's. */
    function mismatched(): string[] {
      return commits.filter((c) => {
        const [, page, full, selected] =
          /^page (\S+): \S+ location=\/items\/(\S+) .*\| location=\/items\/(\S+) /.exec(
            c,
          )!;
        return full !== page || selected !== page;
      });
    }

    it("reads the page on screen as location and the click's URL as pendingUrl, until the newer page shows", async () => {
      const { getByTestId, router, second } = await mount();

      const third = deferredItem();
      const newer = router.navigate("/items/3", {
        loaders: [[ItemLoader, third.promise]],
      });
      // The click's own notification, delivered at once over page 1.
      expect(getByTestId("item").textContent).toBe("1");
      expect(getByTestId("nav").textContent).toBe(
        "loading location=/items/1 pendingUrl=/items/3 | location=/items/1 pendingUrl=/items/3",
      );

      // Page 3 is handed over too; React holds both, and page 2 never shows.
      await act(async () => {
        await newer;
        second.resolve("2");
        await second.promise;
      });
      expect(getByTestId("item").textContent).toBe("1");
      expect(getByTestId("nav").textContent).toBe(
        "loading location=/items/1 pendingUrl=/items/3 | location=/items/1 pendingUrl=/items/3",
      );

      await act(async () => {
        third.resolve("3");
        await third.promise;
      });
      await waitFor(() =>
        expect(getByTestId("nav").textContent).toBe(
          "idle location=/items/3 pendingUrl=- | location=/items/3 pendingUrl=-",
        ),
      );
      expect(getByTestId("item").textContent).toBe("3");
      expect(commits.filter((c) => c.includes("location=/items/2"))).toEqual(
        [],
      );
      expect(mismatched()).toEqual([]);
    });

    it("when the held page shows before the newer click's response, location moves with it", async () => {
      const { getByTestId, router, second } = await mount();

      // The newer click's request is out; its response never arrives here.
      const newer = router.eventController.startNavigation(
        new URL("/items/3", "http://localhost").href,
      );
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
      expect(getByTestId("nav").textContent).toBe(
        "loading location=/items/1 pendingUrl=/items/3 | location=/items/1 pendingUrl=/items/3",
      );

      await act(async () => {
        second.resolve("2");
        await second.promise;
      });
      await waitFor(() => expect(getByTestId("item").textContent).toBe("2"));
      expect(getByTestId("nav").textContent).toBe(
        "loading location=/items/2 pendingUrl=/items/3 | location=/items/2 pendingUrl=/items/3",
      );

      await act(async () => {
        newer[Symbol.dispose]();
        await new Promise((r) => setTimeout(r, 0));
      });
      expect(getByTestId("nav").textContent).toBe(
        "idle location=/items/2 pendingUrl=- | location=/items/2 pendingUrl=-",
      );
      expect(mismatched()).toEqual([]);
    });
  },
);
