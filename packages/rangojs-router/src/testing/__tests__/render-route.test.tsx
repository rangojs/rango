// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from "vitest";
import { cleanup } from "@testing-library/react";
import { Outlet } from "../../client.js";
import { useParams } from "../../browser/react/use-params.js";
import { useReverse } from "../../browser/react/use-reverse.js";
import { useNavigation } from "../../browser/react/use-navigation.js";
import { usePathname } from "../../browser/react/use-pathname.js";
import { useLoader } from "../../use-loader.js";
import type { LoaderDefinition } from "../../types.js";
import { renderRoute } from "../render-route.js";

afterEach(() => {
  cleanup();
});

describe("renderRoute", () => {
  it("resolves useParams + useReverse + Outlet through the layout chain", async () => {
    function Layout() {
      return (
        <div>
          <span data-testid="shell">shell</span>
          <Outlet />
        </div>
      );
    }

    function Product() {
      const { productId } = useParams<{ productId: string }>();
      const reverse = useReverse({
        product: "/products/:productId",
      });
      return (
        <div>
          <span data-testid="param">{productId}</span>
          <a data-testid="link" href={reverse("product", { productId: "2" })}>
            next
          </a>
        </div>
      );
    }

    const { getByTestId } = await renderRoute(
      [
        { path: "/products", Component: Layout },
        { path: "/products/:productId", Component: Product },
      ],
      { initialUrl: "/products/1" },
    );

    // Layout (Outlet) wraps the route.
    expect(getByTestId("shell").textContent).toBe("shell");
    // useParams resolves the route param from the URL.
    expect(getByTestId("param").textContent).toBe("1");
    // useReverse substitutes explicit params against the local map.
    expect(getByTestId("link").getAttribute("href")).toBe("/products/2");
  });

  it("merges explicit params over URL-extracted params", async () => {
    function Page() {
      const { id, mode } = useParams<{ id: string; mode: string }>();
      return <span data-testid="out">{`${id}:${mode}`}</span>;
    }

    const { getByTestId } = await renderRoute(
      [{ path: "/items/:id", Component: Page }],
      { initialUrl: "/items/42", params: { mode: "edit" } },
    );

    expect(getByTestId("out").textContent).toBe("42:edit");
  });

  it("exposes navigation state via useNavigation and navigate() swaps content", async () => {
    function Page() {
      const { id } = useParams<{ id: string }>();
      const nav = useNavigation();
      const pathname = usePathname();
      return (
        <div>
          <span data-testid="id">{id}</span>
          <span data-testid="state">{nav.state}</span>
          <span data-testid="path">{pathname}</span>
        </div>
      );
    }

    const { getByTestId, router } = await renderRoute(
      [{ path: "/users/:id", Component: Page }],
      { initialUrl: "/users/alice" },
    );

    expect(getByTestId("id").textContent).toBe("alice");
    expect(getByTestId("state").textContent).toBe("idle");
    expect(getByTestId("path").textContent).toBe("/users/alice");

    await router.navigate("/users/bob");

    expect(router.pathname()).toBe("/users/bob");
    expect(router.params()).toEqual({ id: "bob" });
    expect(getByTestId("id").textContent).toBe("bob");
  });

  it("seeds loaderData so useLoader resolves from context", async () => {
    const ProfileLoader = {
      __brand: "loader",
      $$id: "loaders/profile#ProfileLoader",
    } as unknown as LoaderDefinition<{ name: string }>;

    function Profile() {
      const { data } = useLoader(ProfileLoader);
      return <span data-testid="name">{data.name}</span>;
    }

    const { getByTestId } = await renderRoute(
      [{ path: "/profile", Component: Profile }],
      {
        initialUrl: "/profile",
        loaderData: { [ProfileLoader.$$id]: { name: "Ada" } },
      },
    );

    expect(getByTestId("name").textContent).toBe("Ada");
  });

  it("attaches loader data to a layout segment via loaderIds", async () => {
    const CartLoader = {
      __brand: "loader",
      $$id: "loaders/cart#CartLoader",
    } as unknown as LoaderDefinition<{ count: number }>;

    function CartLayout() {
      const { data } = useLoader(CartLoader);
      return (
        <div>
          <span data-testid="cart">{data.count}</span>
          <Outlet />
        </div>
      );
    }
    function Page() {
      return <span data-testid="page">page</span>;
    }

    const { getByTestId } = await renderRoute(
      [
        {
          path: "/shop",
          Component: CartLayout,
          loaderIds: [CartLoader.$$id],
        },
        { path: "/shop/item", Component: Page },
      ],
      {
        initialUrl: "/shop/item",
        loaderData: { [CartLoader.$$id]: { count: 3 } },
      },
    );

    expect(getByTestId("cart").textContent).toBe("3");
    expect(getByTestId("page").textContent).toBe("page");
  });
});
