// @vitest-environment happy-dom
import { describe, it, expect, afterEach, vi } from "vitest";
import { Suspense, useEffect, useState } from "react";
import { act, cleanup, fireEvent } from "@testing-library/react";
import { Outlet } from "../../client.js";
import { Link } from "../../browser/react/Link.js";
import { useParams } from "../../browser/react/use-params.js";
import { useRouter } from "../../browser/react/use-router.js";
import { useLoader } from "../../use-loader.js";
import type { LoaderDefinition } from "../../types.js";
import { createLocationState } from "../../browser/react/location-state-shared.js";
import { runTransitionWhen, withLocationStateKey } from "../index.js";
import { renderRoute } from "../dom.entry.js";
import type { TransitionWhenContext } from "../../types/segments.js";

/**
 * transition({ when }) through the public @rangojs/router/testing primitives:
 * runTransitionWhen builds the browser context and evaluates the predicate
 * with production's functions; renderRoute decides each navigate() /
 * refresh() commit like the browser does.
 */

afterEach(() => cleanup());

const ProductState = withLocationStateKey(
  createLocationState<{ animate: boolean }>(),
  "tx-when-test-product",
);

describe("runTransitionWhen", () => {
  it("builds { kind, from, to, isAction } and applies the predicate", () => {
    let seen: TransitionWhenContext | undefined;
    const result = runTransitionWhen(
      (ctx) => {
        seen = ctx;
        return ctx.from.params.n !== "b";
      },
      {
        from: { url: "/tx/b", params: { n: "b" }, routeName: "tx" },
        to: { url: "/tx/a?x=1", params: { n: "a" }, routeName: "tx" },
      },
    );
    expect(result).toMatchObject({ applied: false, gatedOff: true });
    expect(result.context).toBe(seen);
    expect(seen!.kind).toBe("push");
    expect(seen!.from.url.pathname).toBe("/tx/b");
    expect(seen!.to.url.search).toBe("?x=1");
    expect(seen!.to).toMatchObject({ params: { n: "a" }, routeName: "tx" });
    expect(seen!.isAction()).toBe(false);
    expect(seen!.action).toBeUndefined();
  });

  it("reads typed location state from the destination with Def.read(ctx.to)", () => {
    const when = (ctx: TransitionWhenContext) =>
      ProductState.read(ctx.to)?.animate !== false;
    expect(
      runTransitionWhen(when, {
        from: "/products/1",
        to: { url: "/products/2", state: [ProductState({ animate: false })] },
      }).applied,
    ).toBe(false);
    expect(
      runTransitionWhen(when, {
        to: { url: "/products/2", state: [ProductState({ animate: true })] },
      }).applied,
    ).toBe(true);
    // No state pushed: the predicate sees none.
    expect(runTransitionWhen(when, { to: "/products/2" }).applied).toBe(true);
  });

  it("models an action commit: to === from, isAction matches the imported action", () => {
    const addToCart = Object.assign(async () => {}, { $$id: "cart#add" });
    const other = Object.assign(async () => {}, { $$id: "cart#remove" });
    const formData = new FormData();
    const { context } = runTransitionWhen(() => true, {
      from: "/cart",
      action: { ref: addToCart, formData, result: { count: 2 } },
    });
    expect(context.kind).toBe("action");
    expect(context.to).toBe(context.from);
    expect(context.isAction()).toBe(true);
    expect(context.isAction(addToCart)).toBe(true);
    expect(context.isAction(other)).toBe(false);
    expect(context.action).toEqual({
      id: "cart#add",
      formData,
      result: { count: 2 },
      error: undefined,
    });

    const failure = new Error("out of stock");
    const failed = runTransitionWhen((ctx) => ctx.action?.error === undefined, {
      action: { ref: "cart#add", error: failure },
    });
    expect(failed.gatedOff).toBe(true);
    expect(failed.context.action?.error).toBe(failure);
  });

  it("defaults `to` to `from` (same params, routeName and state)", () => {
    const { context } = runTransitionWhen(() => true, {
      from: {
        url: "http://localhost/p/1",
        params: { id: "1" },
        routeName: "p",
        state: { s: 1 },
      },
    });
    expect(context.to).toBe(context.from);
    expect(context.to).toMatchObject({
      params: { id: "1" },
      routeName: "p",
      state: { s: 1 },
    });
  });

  it("models a refresh (kind revalidate): to === from", () => {
    const { context } = runTransitionWhen(() => true, {
      kind: "revalidate",
      from: "/list?page=2",
      to: "/ignored",
    });
    expect(context.to).toBe(context.from);
    expect(context.to.url.search).toBe("?page=2");
  });

  it("applies a config without `when`; a throw gates off and is logged", () => {
    expect(runTransitionWhen({ enter: "fade" }).applied).toBe(true);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const thrown = runTransitionWhen(() => {
      throw new Error("boom");
    });
    expect(thrown.gatedOff).toBe(true);
    expect(error).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });

  it("rejects an action function without an id", () => {
    expect(() =>
      runTransitionWhen(() => true, { action: async () => {} }),
    ).toThrow("runTransitionWhen: `action` must be a single imported server");
  });
});

let mounts = 0;
function Probe() {
  const params = useParams<{ id?: string }>();
  const [clicks, setClicks] = useState(0);
  useEffect(() => {
    mounts++;
  }, []);
  return (
    <button data-testid="inc" onClick={() => setClicks((c) => c + 1)}>
      {`${params.id}:clicks:${clicks}`}
    </button>
  );
}

async function navigateAll(
  router: { navigate(url: string): Promise<void> },
  ids: string[],
) {
  for (const id of ids) {
    await router.navigate(`/items/${id}`);
    await act(async () => {});
  }
}

describe("renderRoute: transition({ when }) decides each commit (#995)", () => {
  it.each([
    ["router <ViewTransition>", {}],
    ["viewTransition: false", { viewTransition: false as const }],
  ])(
    "no remount across when true -> false -> true (%s)",
    async (_label, extra) => {
      mounts = 0;
      const seen: string[] = [];
      const when = (ctx: TransitionWhenContext) => {
        const result = ctx.from.params.id !== "2";
        seen.push(
          `${ctx.kind} ${ctx.from.url.pathname}->${ctx.to.url.pathname} ${ctx.to.routeName}:${result}`,
        );
        return result;
      };
      const { getByTestId, router } = await renderRoute(
        [
          {
            path: "/items/:id",
            name: "items.detail",
            Component: Probe,
            transition: { ...extra, when },
          },
        ],
        { request: "/items/1" },
      );
      fireEvent.click(getByTestId("inc"));
      fireEvent.click(getByTestId("inc"));
      await navigateAll(router, ["2", "3", "4"]);
      expect(seen).toEqual([
        "push /items/1->/items/2 items.detail:true",
        "push /items/2->/items/3 items.detail:false",
        "push /items/3->/items/4 items.detail:true",
      ]);
      expect(getByTestId("inc").textContent).toBe("4:clicks:2");
      expect(mounts).toBe(1);
    },
  );

  it("a transition() with no when applies to every navigation", async () => {
    mounts = 0;
    const { getByTestId, router } = await renderRoute(
      [{ path: "/items/:id", Component: Probe, transition: {} }],
      { request: "/items/1" },
    );
    fireEvent.click(getByTestId("inc"));
    await navigateAll(router, ["2", "3"]);
    expect(getByTestId("inc").textContent).toBe("3:clicks:1");
    expect(mounts).toBe(1);
  });

  it("a throwing when gates the navigation off, logs, and does not remount", async () => {
    mounts = 0;
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { getByTestId, router } = await renderRoute(
      [
        {
          path: "/items/:id",
          Component: Probe,
          transition: {
            when: () => {
              throw new Error("boom");
            },
          },
        },
      ],
      { request: "/items/1" },
    );
    fireEvent.click(getByTestId("inc"));
    await navigateAll(router, ["2"]);
    expect(
      error.mock.calls.some((call) =>
        String(call[0]).includes("transition({ when }) threw"),
      ),
    ).toBe(true);
    expect(getByTestId("inc").textContent).toBe("2:clicks:1");
    expect(mounts).toBe(1);
    error.mockRestore();
  });

  it("refresh() decides with kind revalidate on the current location", async () => {
    const seen: TransitionWhenContext[] = [];
    const { router } = await renderRoute(
      [
        {
          path: "/items/:id",
          Component: Probe,
          transition: {
            when: (ctx) => {
              seen.push(ctx);
              return true;
            },
          },
        },
      ],
      { request: "/items/1" },
    );
    await navigateAll(router, ["2"]);
    await router.refresh();
    await act(async () => {});
    expect(seen.map((ctx) => ctx.kind)).toEqual(["push", "revalidate"]);
    expect(seen[1]!.to).toBe(seen[1]!.from);
    expect(seen[1]!.from.url.pathname).toBe("/items/2");
  });
});

describe("renderRoute: per-navigation transition: false", () => {
  const ProductLoader = { __brand: "loader" } as unknown as LoaderDefinition<{
    name: string;
  }>;

  function Shell() {
    return (
      <Suspense fallback={<p data-testid="skeleton">skeleton</p>}>
        <Outlet />
      </Suspense>
    );
  }

  function Product() {
    const { data, isLoading } = useLoader(ProductLoader);
    const router = useRouter();
    return (
      <>
        <p data-testid="price">{`${isLoading ? "stale" : "fresh"}:${data.name}`}</p>
        <Link to="/products/2" transition={false} data-testid="link-off">
          next
        </Link>
        <button
          data-testid="push-off"
          onClick={() => void router.push("/products/3", { transition: false })}
        >
          push
        </button>
      </>
    );
  }

  async function renderProducts(when: () => boolean) {
    return renderRoute(
      [
        { path: "/products", Component: Shell },
        {
          path: "/products/:id",
          Component: Product,
          transition: { when },
        },
      ],
      {
        request: "/products/1",
        loaders: [[ProductLoader, { name: "Product 1" }]],
      },
    );
  }

  it("commits urgently without calling when: the pending read suspends to its fallback", async () => {
    const when = vi.fn(() => true);
    const { getByTestId, queryByTestId, router } = await renderProducts(when);

    let resolve!: (value: { name: string }) => void;
    const next = new Promise<{ name: string }>((r) => (resolve = r));
    await router.navigate("/products/2", {
      transition: false,
      loaders: [[ProductLoader, next]],
    });
    expect(when).not.toHaveBeenCalled();
    expect(getByTestId("skeleton")).toBeTruthy();

    await act(async () => resolve({ name: "Product 2" }));
    expect(queryByTestId("skeleton")).toBeNull();
    expect(getByTestId("price").textContent).toBe("fresh:Product 2");

    // Without the opt-out the same route holds the reader (when -> true).
    let resolveNext!: (value: { name: string }) => void;
    const pending = new Promise<{ name: string }>((r) => (resolveNext = r));
    await router.navigate("/products/3", {
      loaders: [[ProductLoader, pending]],
    });
    expect(when).toHaveBeenCalledTimes(1);
    expect(queryByTestId("skeleton")).toBeNull();
    expect(getByTestId("price").textContent).toBe("stale:Product 2");
    await act(async () => resolveNext({ name: "Product 3" }));
  });

  it("<Link transition={false}> and router.push(url, { transition: false }) skip the predicate", async () => {
    const when = vi.fn(() => true);
    const { getByTestId, router } = await renderProducts(when);

    await act(async () => {
      fireEvent.click(getByTestId("link-off"));
    });
    expect(getByTestId("link-off").getAttribute("data-transition")).toBe(
      "false",
    );
    expect(router.pathname()).toBe("/products/2");

    await act(async () => {
      fireEvent.click(getByTestId("push-off"));
    });
    expect(router.pathname()).toBe("/products/3");
    expect(when).not.toHaveBeenCalled();
  });
});
