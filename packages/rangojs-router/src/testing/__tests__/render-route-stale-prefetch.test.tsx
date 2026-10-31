// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useEffect, useRef, type ReactNode } from "react";
import { act, cleanup, waitFor } from "@testing-library/react";
import { Outlet } from "../../client.js";
import { useNavigation } from "../../browser/react/use-navigation.js";
import { useParams } from "../../browser/react/use-params.js";
import { useLoader } from "../../use-loader.js";
import type { LoaderDefinition } from "../../types.js";
import { renderRoute } from "../render-route.js";

// Consumer contract (#1329): a server action without a directive marks the
// prefetches made before it stale instead of flushing them. A click on one
// shows the prefetched page at once, with the data it was prefetched with,
// then the page revalidates in the background and shows the loaders'
// post-write values: useNavigation() stays idle during that revalidation, and
// the page keeps its instance. keepClientCache() keeps the prefetch fresh: the
// click shows it with no revalidation.

const BasketLoader = {
  __brand: "loader",
  $$id: "loaders/basket#BasketLoader",
} as unknown as LoaderDefinition<{ count: number }>;

let navigationLog: string[];
let pageMounts: number;

function Header(): ReactNode {
  const { data } = useLoader(BasketLoader);
  const state = useNavigation((nav) => nav.state);
  navigationLog.push(state);
  return (
    <div>
      <span data-testid="header-count">{data.count}</span>
      <Outlet />
    </div>
  );
}

function Page(): ReactNode {
  const { page } = useParams<{ page: string }>();
  const { data } = useLoader(BasketLoader);
  const mounted = useRef(false);
  useEffect(() => {
    if (mounted.current) return;
    mounted.current = true;
    pageMounts++;
  }, []);
  return (
    <span data-testid="page">
      {page}:{data.count}
    </span>
  );
}

const routes = [
  { path: "/", Component: Header, loaderIds: [BasketLoader.$$id] },
  { path: "/:page", Component: Page },
];

beforeEach(() => {
  navigationLog = [];
  pageMounts = 0;
});

afterEach(() => {
  cleanup();
});

describe("renderRoute: a click on a prefetch made before a server action", () => {
  it("shows the prefetched page at once, then its loaders' post-write values, idle and in place", async () => {
    const { getByTestId, router } = await renderRoute(routes, {
      request: "/home",
      loaders: [[BasketLoader, { count: 2 }]],
    });
    router.prefetch("/cart");

    // The add: the page on screen shows the write with the action's own
    // response.
    await router.action({ loaders: [[BasketLoader, { count: 3 }]] });
    expect(getByTestId("header-count").textContent).toBe("3");
    expect(getByTestId("page").textContent).toBe("home:3");

    await router.navigate("/cart");
    // The prefetch, made before the add, commits at once.
    expect(getByTestId("page").textContent).toBe("cart:2");
    expect(getByTestId("header-count").textContent).toBe("2");
    const mountsAtClick = pageMounts;
    const sinceClick = navigationLog.length;

    await waitFor(() => expect(getByTestId("page").textContent).toBe("cart:3"));
    expect(getByTestId("header-count").textContent).toBe("3");
    // The revalidation never reads as a navigation, and remounts nothing.
    expect(navigationLog.slice(sinceClick)).not.toContain("loading");
    expect(router.eventController.getState().state).toBe("idle");
    expect(pageMounts).toBe(mountsAtClick);
  });

  it("keepClientCache() keeps the prefetch fresh: the click shows it with no revalidation", async () => {
    const { getByTestId, router } = await renderRoute(routes, {
      request: "/home",
      loaders: [[BasketLoader, { count: 2 }]],
    });
    router.prefetch("/cart");

    await router.action({
      loaders: [[BasketLoader, { count: 3 }]],
      keepClientCache: true,
    });
    await router.navigate("/cart");
    expect(getByTestId("page").textContent).toBe("cart:2");

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(getByTestId("page").textContent).toBe("cart:2");
  });

  it("a prefetch made after the action is fresh: the click shows it with no revalidation", async () => {
    const { getByTestId, router } = await renderRoute(routes, {
      request: "/home",
      loaders: [[BasketLoader, { count: 2 }]],
    });

    await router.action({ loaders: [[BasketLoader, { count: 3 }]] });
    router.prefetch("/cart");
    await router.navigate("/cart");
    expect(getByTestId("page").textContent).toBe("cart:3");

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(getByTestId("page").textContent).toBe("cart:3");
    expect(navigationLog.at(-1)).toBe("idle");
  });

  it("a newer navigation before the revalidation lands keeps its own page", async () => {
    const { getByTestId, router } = await renderRoute(routes, {
      request: "/home",
      loaders: [[BasketLoader, { count: 2 }]],
    });
    router.prefetch("/cart");
    await router.action({ loaders: [[BasketLoader, { count: 3 }]] });

    await router.navigate("/cart");
    expect(getByTestId("page").textContent).toBe("cart:2");
    await router.navigate("/orders");
    expect(getByTestId("page").textContent).toBe("orders:3");

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(getByTestId("page").textContent).toBe("orders:3");
  });

  it("a transition() route holds the revalidation until its data lands, idle throughout", async () => {
    function Reader(): ReactNode {
      const { data, isLoading } = useLoader(BasketLoader);
      const idle = useNavigation((nav) => nav.state === "idle");
      return (
        <span data-testid="reader">
          {`${data.count} ${isLoading ? "loading" : "settled"} ${idle ? "idle" : "busy"}`}
        </span>
      );
    }
    const { getByTestId, router } = await renderRoute(
      [
        { path: "/", Component: Header, loaderIds: [BasketLoader.$$id] },
        { path: "/:page", Component: Reader, transition: {} },
      ],
      { request: "/home", loaders: [[BasketLoader, { count: 2 }]] },
    );
    router.prefetch("/cart");

    let land!: (value: { count: number }) => void;
    const written = new Promise<{ count: number }>((r) => (land = r));
    // The write's data is still pending: React holds the action's own commit
    // on it (not awaited, as a transition React holds never settles act()).
    void router.action({ loaders: [[BasketLoader, written]] });
    await router.navigate("/cart");
    expect(getByTestId("reader").textContent).toBe("2 settled idle");

    // The revalidation reads the pending post-write data: React holds the
    // page on the prefetch's values, and useNavigation() stays idle.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(getByTestId("reader").textContent).toMatch(/^2 .* idle$/);

    await act(async () => {
      land({ count: 3 });
      await written;
    });
    await waitFor(() =>
      expect(getByTestId("reader").textContent).toBe("3 settled idle"),
    );
  });
});
