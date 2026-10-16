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
// holds a page. In production the server answers it with a blocked or
// external redirect, or a router reload (the e2e nav-idle-overlap suite);
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
