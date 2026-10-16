// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Suspense, type ReactNode } from "react";
import { act, cleanup, waitFor } from "@testing-library/react";
import { createLocationState, Outlet } from "../../client.js";
import { useNavigation } from "../../browser/react/use-navigation.js";
import { useSearchParams } from "../../browser/react/use-search-params.js";
import { useLoader } from "../../use-loader.js";
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
        // The click's own notification, delivered at once over the old page.
        expect(log).toContain("loading pu=?tag=c tag=a&tag=b [a,b]");

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
