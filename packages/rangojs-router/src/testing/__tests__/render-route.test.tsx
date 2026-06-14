// @vitest-environment happy-dom
import { describe, it, expect, afterEach, vi } from "vitest";
import { Suspense, use } from "react";
import { cleanup } from "@testing-library/react";
import { Outlet } from "../../client.js";
import { Breadcrumbs, type BreadcrumbItem } from "../../handles/breadcrumbs.js";
import type { DeferredHandleEntry } from "../../defer.js";
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

describe("renderRoute option migration guard", () => {
  it("throws a clear migration error when the renamed `initialUrl` option is passed", async () => {
    function View() {
      return <span>x</span>;
    }
    await expect(
      renderRoute([{ path: "/", Component: View }], {
        initialUrl: "/",
      } as any),
    ).rejects.toThrow(/`initialUrl` option was renamed to `request`/);
  });
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

  it("keeps seeded handles resolvable across router.navigate() (#20)", async () => {
    // Handles are seeded once at initial render and persist across navigate()
    // within the test (like loaderData) — unlike a real navigation, which would
    // re-run handlers. Pin that a handle still resolves after navigate().
    const Crumbs = createHandle<string, string>((segments) =>
      segments.flat().join(" > "),
    );
    function View() {
      const { id } = useParams<{ id: string }>();
      return (
        <div>
          <span data-testid="id">{id}</span>
          <span data-testid="crumbs">{useHandle(Crumbs)}</span>
        </div>
      );
    }
    const { getByTestId, router } = await renderRoute(
      [{ path: "/users/:id", Component: View }],
      { request: "/users/alice", handles: [[Crumbs, ["Home", "Users"]]] },
    );
    expect(getByTestId("crumbs").textContent).toBe("Home > Users");

    await router.navigate("/users/bob");

    expect(getByTestId("id").textContent).toBe("bob");
    expect(getByTestId("crumbs").textContent).toBe("Home > Users");
  });
});

// The client-read half of ctx.use(Handle).defer(): a deferred slot arrives in the
// accumulated handle data as a Promise (a DeferredHandleEntry) that a
// deferred-aware component use()s inside Suspense. renderRoute settles that
// Suspense within act (see the awaited-act render), so a deferred handle renders
// and is assertable from the resolved DOM exactly like a sync one — no e2e
// needed. (The server-push half is covered by renderHandler's .defer() tests.)
function isThenable(v: unknown): v is Promise<unknown> {
  return v != null && typeof (v as { then?: unknown }).then === "function";
}

function DeferredCrumb({ c }: { c: DeferredHandleEntry<BreadcrumbItem> }) {
  const item = isThenable(c) ? (use(c) as BreadcrumbItem) : c;
  return <span data-testid="crumb">{item.label}</span>;
}

function DeferredCrumbs() {
  const crumbs = useHandle(Breadcrumbs) as Array<
    DeferredHandleEntry<BreadcrumbItem>
  >;
  return (
    <div>
      {crumbs.map((c, i) => (
        <Suspense key={i} fallback={<span data-testid="crumb-pending" />}>
          <DeferredCrumb c={c} />
        </Suspense>
      ))}
    </div>
  );
}

describe("renderRoute deferred handle entries (.defer())", () => {
  it("renders a deferred (Promise) entry once it resolves, alongside sync ones", async () => {
    const { getAllByTestId } = await renderRoute(
      [{ path: "/", Component: DeferredCrumbs }],
      {
        request: "/",
        handles: [
          [
            Breadcrumbs,
            [
              { label: "Home", href: "/" },
              Promise.resolve({ label: "Deferred", href: "/d" }),
            ],
          ],
        ],
      },
    );
    expect(getAllByTestId("crumb").map((e) => e.textContent)).toEqual([
      "Home",
      "Deferred",
    ]);
  });

  it("renders multiple concurrent deferred entries without collapsing them (collectBreadcrumbs href dedup)", async () => {
    // Before the deferred-aware collect, both pending Promises hashed to href
    // `undefined` and the dedup kept only the last. Both must render.
    const { getAllByTestId } = await renderRoute(
      [{ path: "/", Component: DeferredCrumbs }],
      {
        request: "/",
        handles: [
          [
            Breadcrumbs,
            [
              Promise.resolve({ label: "First", href: "/1" }),
              Promise.resolve({ label: "Second", href: "/2" }),
            ],
          ],
        ],
      },
    );
    expect(getAllByTestId("crumb").map((e) => e.textContent)).toEqual([
      "First",
      "Second",
    ]);
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
      { request: "/products/1" },
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
      { request: "/items/42", params: { mode: "edit" } },
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
      { request: "/users/alice" },
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
        request: "/profile",
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
        request: "/shop/item",
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
      { mount: "/shop", request: "/c/wine" },
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
      { mount: "/shop", request: "/c/wine" },
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
      { mount: "/shop", request: "/c/wine" },
    );
    expect(getByTestId("rev").getAttribute("href")).toBe("/shop/c/wine");
    expect(getByTestId("href").getAttribute("href")).toBe("/shop/cart");
  });

  it("accepts a route path that itself equals the mount (production parity, no false guard)", async () => {
    // renderRoute paths are include-RELATIVE; production simply prefixes them, so
    // a relative path of "/shop" under mount "/shop" legitimately models the URL
    // "/shop/shop". renderRoute must NOT reject this — it mirrors prefixing, it
    // does not police it. (The request is the include-relative URL, like the
    // other mount tests above.)
    const { getByTestId } = await renderRoute(
      [{ path: "/shop", Component: MountProbe }],
      { mount: "/shop", request: "/shop" },
    );
    expect(getByTestId("mount").textContent).toBe("/shop");
  });

  it("models a locale-parameterized include (mount = a resolved /:locale? value) (#25)", async () => {
    // include('/:locale?', subApp) mounts the sub-app under a RESOLVED locale
    // prefix (e.g. "/en"). Seeding mount: "/en" reproduces that: useReverse /
    // useHref inside the sub-app prefix by the locale, so a reversed link keeps
    // it — the locale-prefixed-routes pattern, end to end.
    function LocalePage() {
      const reverse = useReverse({ product: "/c/:slug" });
      const href = useHref();
      return (
        <div>
          <span data-testid="mount">{useMount()}</span>
          <a data-testid="rev" href={reverse("product", { slug: "wine" })}>
            x
          </a>
          <span data-testid="href">{href("/c/wine")}</span>
        </div>
      );
    }
    const { getByTestId } = await renderRoute(
      [{ path: "/c/:slug", Component: LocalePage }],
      { mount: "/en", request: "/c/wine" },
    );
    expect(getByTestId("mount").textContent).toBe("/en");
    expect(getByTestId("rev").getAttribute("href")).toBe("/en/c/wine");
    expect(getByTestId("href").textContent).toBe("/en/c/wine");
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
      { request: "/en/c/wine" },
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
      { request: "/c/wine" },
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
        request: "/p/x",
        handles: [[Crumbs, [{ label: "Home" }, { label: "P" }]]],
      },
    );
    expect(getByTestId("crumbs").textContent).toBe("Home>P");
    expect(getByTestId("leaf").textContent).toBe("leaf");
  });
});

describe("renderRoute navigation lifecycle is frozen at idle", () => {
  // navigate() commits synchronously (no server fetch / Flight stream), so the
  // transition state useNavigation/useLinkStatus/useAction read never leaves
  // "idle". A test that asserts a non-idle state would silently pass; the helper
  // warns once so that false-confidence trap is loud.
  it("stays idle across navigate() and warns once, naming the affected hooks", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      function Page() {
        const nav = useNavigation();
        return <span data-testid="state">{nav.state}</span>;
      }
      const { getByTestId, router } = await renderRoute(
        [{ path: "/a", Component: Page }],
        { request: "/a" },
      );

      expect(getByTestId("state").textContent).toBe("idle");
      await router.navigate("/a");
      // Contract: the transition state is frozen at idle even after navigate().
      expect(getByTestId("state").textContent).toBe("idle");
      await router.navigate("/a");

      const navWarns = warn.mock.calls.filter((c) =>
        String(c[0]).includes("navigate()"),
      );
      expect(navWarns).toHaveLength(1);
      expect(String(navWarns[0][0])).toMatch(/useNavigation\(\)\.state/);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("renderRoute request/leaf validation", () => {
  function Probe() {
    const { slug } = useParams<{ slug?: string }>();
    return <span data-testid="slug">{slug ?? "none"}</span>;
  }

  it("rejects a request that does not match the leaf route", async () => {
    await expect(
      renderRoute([{ path: "/c/:slug", Component: Probe }], {
        request: "/typo/wine",
      }),
    ).rejects.toThrow(/does not match the leaf route/);
  });

  it("rejects a mount-PREFIXED request (paths are include-relative)", async () => {
    // The classic mistake: assuming the mount auto-prefixes the request. It does
    // not — resolve() matches the request against the leaf as-is, so a prefixed
    // request would silently yield empty params. Reject it with guidance.
    await expect(
      renderRoute([{ path: "/c/:slug", Component: Probe }], {
        mount: "/en",
        request: "/en/c/wine",
      }),
    ).rejects.toThrow(/A mount does NOT auto-rewrite the request/);
  });

  it("accepts the relative request under a dynamic mount and extracts params", async () => {
    function LocaleProbe() {
      const { slug } = useParams<{ slug?: string }>();
      return (
        <div>
          <span data-testid="slug">{slug ?? "none"}</span>
          <span data-testid="mount">{useMount()}</span>
        </div>
      );
    }
    const { getByTestId } = await renderRoute(
      [{ path: "/c/:slug", Component: LocaleProbe }],
      { mount: "/en", request: "/c/wine" },
    );
    expect(getByTestId("slug").textContent).toBe("wine");
    expect(getByTestId("mount").textContent).toBe("/en");
  });

  it("accepts a non-matching request when explicit params are supplied", async () => {
    // The params docstring blesses passing `params` "to avoid relying on URL
    // parsing". Such a test legitimately wants `request` for search/path context
    // while seeding params by hand, so the leaf-match guard must NOT fire — the
    // explicit params, not the URL, are the param source.
    const { getByTestId } = await renderRoute(
      [{ path: "/c/:slug", Component: Probe }],
      { request: "/some/other/path?ref=email", params: { slug: "wine" } },
    );
    expect(getByTestId("slug").textContent).toBe("wine");
  });

  it("still rejects a non-matching request when params is empty", async () => {
    // An empty params object provides no param source, so the trap (silent empty
    // params) still applies and the guard fires.
    await expect(
      renderRoute([{ path: "/c/:slug", Component: Probe }], {
        request: "/typo/wine",
        params: {},
      }),
    ).rejects.toThrow(/does not match the leaf route/);
  });

  it("accepts an optional :locale? leaf that the request omits", async () => {
    const { getByTestId } = await renderRoute(
      [{ path: "/:locale?/c/:slug", Component: Probe }],
      { request: "/c/wine" },
    );
    expect(getByTestId("slug").textContent).toBe("wine");
  });

  it("is inert when no request is passed (defaults from the leaf static prefix)", async () => {
    const { getByTestId } = await renderRoute(
      [{ path: "/c/wine", Component: Probe }],
      { mount: "/shop" },
    );
    expect(getByTestId("slug").textContent).toBe("none");
  });

  it("is silent off the test runner (production gate)", async () => {
    vi.stubEnv("VITEST", "");
    try {
      const { getByTestId } = await renderRoute(
        [{ path: "/c/:slug", Component: Probe }],
        { request: "/typo/wine" },
      );
      // A typo that WOULD throw under the runner renders empty params instead.
      expect(getByTestId("slug").textContent).toBe("none");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
