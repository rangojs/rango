// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Suspense, type ReactNode } from "react";
import { act, cleanup, waitFor } from "@testing-library/react";
import { Outlet } from "../../client.js";
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
