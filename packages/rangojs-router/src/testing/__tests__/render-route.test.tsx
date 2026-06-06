// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from "vitest";
import { cleanup } from "@testing-library/react";
import { Outlet } from "../../client.js";
import { useParams } from "../../browser/react/use-params.js";
import { useReverse } from "../../browser/react/use-reverse.js";
import { useHref } from "../../browser/react/use-href.js";
import { useNavigation } from "../../browser/react/use-navigation.js";
import { usePathname } from "../../browser/react/use-pathname.js";
import { useLoader } from "../../use-loader.js";
import { useHandle } from "../../browser/react/use-handle.js";
import { useMount } from "../../browser/react/use-mount.js";
import { createHandle } from "../../handle.js";
import type { LoaderDefinition } from "../../types.js";
import { renderRoute } from "../render-route.js";

afterEach(() => {
  cleanup();
});

describe("renderRoute handles seeding runs the real collect", () => {
  it("applies a handle's CUSTOM collect (not just a flatten) to seeded values", () => {
    const LastTitle = createHandle<string, string>(
      (segments) => segments.flat().at(-1) ?? "none",
    );
    function TitleView() {
      const title = useHandle(LastTitle);
      return <span data-testid="title">{title}</span>;
    }

    return renderRoute([{ path: "/p", Component: TitleView }], {
      handles: [[LastTitle, ["A", "B", "C"]]],
    }).then(({ getByTestId }) => {
      // "last wins" collect -> "C", not the flattened array.
      expect(getByTestId("title").textContent).toBe("C");
    });
  });
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

describe("renderRoute mount (include() scope)", () => {
  function MountProbe() {
    return <span data-testid="mount">{useMount()}</span>;
  }

  it("defaults useMount() to '/' with no mount option", async () => {
    const { getByTestId } = await renderRoute([
      { path: "/x", Component: MountProbe },
    ]);
    expect(getByTestId("mount").textContent).toBe("/");
  });

  it("seeds useMount() with the mount prefix (models include('/shop', ...))", async () => {
    const { getByTestId } = await renderRoute(
      [{ path: "/c/wine", Component: MountProbe }],
      { mount: "/shop", initialUrl: "/c/wine" },
    );
    expect(getByTestId("mount").textContent).toBe("/shop");
  });

  it("normalizes the mount prefix exactly like basename", async () => {
    const { getByTestId } = await renderRoute(
      [{ path: "/c", Component: MountProbe }],
      { mount: "shop/" },
    );
    expect(getByTestId("mount").textContent).toBe("/shop");
  });

  it("exposes the mount to a LAYOUT component in the chain (not just the leaf)", async () => {
    function Layout() {
      return (
        <div>
          <span data-testid="layout-mount">{useMount()}</span>
          <Outlet />
        </div>
      );
    }
    const { getByTestId } = await renderRoute(
      [
        { path: "/c", Component: Layout },
        { path: "/c/wine", Component: MountProbe },
      ],
      { mount: "/shop", initialUrl: "/c/wine" },
    );
    expect(getByTestId("layout-mount").textContent).toBe("/shop");
    expect(getByTestId("mount").textContent).toBe("/shop");
  });

  it("makes useReverse / useHref prefix by the mount (full include() modeling)", async () => {
    function Linker() {
      const reverse = useReverse({ product: "/c/:slug" });
      const href = useHref();
      return (
        <div>
          <a data-testid="rev" href={reverse("product", { slug: "wine" })}>
            rev
          </a>
          <a data-testid="href" href={href("/cart")}>
            cart
          </a>
        </div>
      );
    }
    const { getByTestId } = await renderRoute(
      [{ path: "/c/wine", Component: Linker }],
      { mount: "/shop", initialUrl: "/c/wine" },
    );
    expect(getByTestId("rev").getAttribute("href")).toBe("/shop/c/wine");
    expect(getByTestId("href").getAttribute("href")).toBe("/shop/cart");
  });
});

describe("renderRoute reverse + optional params from the match", () => {
  // Pin the behavior the consumer asked about: with /:locale?/c/:group at
  // /en/c/wine, does reverse(group, { group }) (NOT passing locale) keep the
  // optional :locale? from the current match? Production useReverse merges
  // useParams() (the matched params) under explicit params, so it should.
  it("auto-fills an optional :locale? present in the match", async () => {
    function Probe() {
      const params = useParams<{ locale?: string; group?: string }>();
      const reverse = useReverse({ group: "/:locale?/c/:group" });
      return (
        <div>
          <span data-testid="locale">{params.locale ?? "none"}</span>
          <a data-testid="rev" href={reverse("group", { group: "food" })}>
            x
          </a>
        </div>
      );
    }
    const { getByTestId } = await renderRoute(
      [{ path: "/:locale?/c/:group", Component: Probe }],
      { initialUrl: "/en/c/wine" },
    );
    expect(getByTestId("locale").textContent).toBe("en");
    expect(getByTestId("rev").getAttribute("href")).toBe("/en/c/food");
  });

  it("omits an optional :locale? that is absent from the match", async () => {
    function Probe() {
      const reverse = useReverse({ group: "/:locale?/c/:group" });
      return (
        <a data-testid="rev" href={reverse("group", { group: "food" })}>
          x
        </a>
      );
    }
    const { getByTestId } = await renderRoute(
      [{ path: "/:locale?/c/:group", Component: Probe }],
      { initialUrl: "/c/wine" },
    );
    expect(getByTestId("rev").getAttribute("href")).toBe("/c/food");
  });
});

describe("renderRoute handles reach LAYOUT components, not just the leaf", () => {
  // The consumer's confusion: a layout (DetailLayout/ActionToolbar) that reads a
  // handle "could not go through renderRoute". It can — handles are accumulated
  // globally on the event controller (unlike loaders, which are segment-scoped
  // via OutletContext), so any component in the chain reads the seeded values.
  it("a LAYOUT reading useHandle sees the seeded values", async () => {
    const Crumbs = createHandle<{ label: string }>();
    function Layout() {
      const crumbs = useHandle(Crumbs);
      return (
        <div>
          <span data-testid="crumbs">
            {crumbs.map((c) => c.label).join(">")}
          </span>
          <Outlet />
        </div>
      );
    }
    function Leaf() {
      return <span data-testid="leaf">leaf</span>;
    }
    const { getByTestId } = await renderRoute(
      [
        { path: "/p", Component: Layout },
        { path: "/p/x", Component: Leaf },
      ],
      {
        initialUrl: "/p/x",
        handles: [[Crumbs, [{ label: "Home" }, { label: "P" }]]],
      },
    );
    expect(getByTestId("crumbs").textContent).toBe("Home>P");
    expect(getByTestId("leaf").textContent).toBe("leaf");
  });
});
