import { describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  clientUrls,
  loader as globalLoader,
  loading as globalLoading,
  revalidate as globalRevalidate,
  transition as globalTransition,
  type ClientUrlBuilder,
  type ClientUrlHelpers,
  type ClientUrlItem,
  type ClientUrlLoaderRecord,
  type ClientUrlRouteRecord,
} from "../client-urls.js";
import type { LoaderDefinition } from "../../types.js";
import type { ComponentType } from "react";
import { Static } from "../../static-handler.js";
import { Prerender } from "../../prerender.js";

function HomePage(): null {
  return null;
}

function UserPage(): null {
  return null;
}

function AppLayout(): null {
  return null;
}

function AccountLayout(): null {
  return null;
}

function AccountPage(): null {
  return null;
}

function SettingsPage(): null {
  return null;
}

function loader(id: string): LoaderDefinition<unknown> {
  return { __brand: "loader", $$id: id };
}

describe("clientUrls", () => {
  it("rejects Static()/Prerender() handler values with a targeted message", () => {
    // Real definitions, not hand-built brands: the rejection must hold for
    // exactly what the server DSL produces.
    const staticDef = Static(() => null);
    const prerenderDef = Prerender(() => null);

    expect(() =>
      clientUrls(({ path }) => [
        path("/static", staticDef as unknown as ComponentType),
      ]),
    ).toThrow(/path\(\) received a Static\(\) handler/);
    expect(() =>
      clientUrls(({ path }) => [
        path("/prerender", prerenderDef as unknown as ComponentType),
      ]),
    ).toThrow(/path\(\) received a Prerender\(\) handler/);
    expect(() =>
      clientUrls(({ layout, path }) => [
        layout(staticDef as unknown as ComponentType, () => [
          path("/x", HomePage),
        ]),
      ]),
    ).toThrow(/layout\(\) received a Static\(\) handler/);
    // The message points at the supported alternative.
    expect(() =>
      clientUrls(({ path }) => [
        path("/static", staticDef as unknown as ComponentType),
      ]),
    ).toThrow(/`ppr` path option/);
  });

  it("accepts the ppr path option and validates its shape", () => {
    // ppr is a PROJECTED option (performance surface): true and the JSON
    // PartialPrerenderProps form pass; malformed values fail at DSL time in
    // the authoring module.
    expect(() =>
      clientUrls(({ path }) => [
        path("/ppr", HomePage, { ppr: true }),
        path("/ppr-config", HomePage, {
          ppr: { ttl: 300, swr: 120, tags: ["shop"] },
        }),
      ]),
    ).not.toThrow();

    expect(() =>
      clientUrls(({ path }) => [
        path("/ppr", HomePage, {
          ppr: { ttl: "300" } as unknown as { ttl: number },
        }),
      ]),
    ).toThrow(/ppr\.ttl must be a finite number/);
    expect(() =>
      clientUrls(({ path }) => [
        path("/ppr", HomePage, {
          ppr: { tags: [""] } as unknown as { tags: string[] },
        }),
      ]),
    ).toThrow(/ppr\.tags must be an array of non-empty strings/);
    expect(() =>
      clientUrls(({ path }) => [
        path("/ppr", HomePage, {
          ppr: { when: () => true } as unknown as { ttl: number },
        }),
      ]),
    ).toThrow(/ppr received unsupported key "when"/);
  });

  it("matches root and dynamic routes without executing component values", () => {
    let componentCalls = 0;
    function TrackedHomePage(): null {
      componentCalls++;
      return null;
    }

    const patterns = clientUrls(({ path }) => [
      path("/", TrackedHomePage, { name: "home" }),
      path("/users/:id", UserPage, { name: "user" }),
    ]);

    expect(patterns.match("/")).toMatchObject({
      routeKey: "client-route-0",
      params: {},
    });
    expect(patterns.match("/users/42")).toMatchObject({
      routeKey: "client-route-1",
      params: { id: "42" },
    });
    expect(patterns.match("/missing")).toBeNull();
    expect(patterns.routes.map((route) => route.component)).toEqual([
      TrackedHomePage,
      UserPage,
    ]);
    expect(componentCalls).toBe(0);
  });

  it("flattens ordered layouts and inherited route configuration", () => {
    const AuthLoader = loader("loaders#auth");
    const AccountLoader = loader("loaders#account");

    const patterns = clientUrls(
      ({ path, layout, loader: useLoader, loading }) => [
        layout(AppLayout, () => [
          useLoader(AuthLoader),
          loading("App loading"),
          layout(AccountLayout, () => [
            path("/account/:id", AccountPage, () => [
              useLoader(AccountLoader),
              loading("Account loading"),
            ]),
          ]),
        ]),
      ],
    );

    const [route] = patterns.routes;
    expect(route.layouts).toEqual([AppLayout, AccountLayout]);
    expect(route.loaders.map((entry) => entry.loader)).toEqual([
      AuthLoader,
      AccountLoader,
    ]);
    expect(route.loading).toBe("Account loading");
  });

  it("shares a layout()'s loader records across its routes as layoutLoaders; a route's own loader() gets its own record", () => {
    const LayoutLoader = loader("loaders#layout");
    const OwnLoader = loader("loaders#own");
    function Shell(): null {
      return null;
    }
    const patterns = clientUrls(({ layout, loader: useLoader, path }) => [
      layout(Shell, () => [
        useLoader(LayoutLoader),
        path("/a", AccountPage, () => [useLoader(OwnLoader)]),
        path("/b", AccountPage, () => [useLoader(OwnLoader)]),
      ]),
    ]);
    const [a, b] = patterns.routes;
    expect(a!.loaders[0]).toBe(b!.loaders[0]);
    expect(a!.loaders[1]).not.toBe(b!.loaders[1]);
    expect(a!.layoutLoaders).toEqual([a!.loaders[0]]);
    expect(a!.layoutLoaders[0]).toBe(b!.layoutLoaders[0]);
  });

  it("stores only projectable route and loader fields", () => {
    const AccountLoader = loader("loaders#account");

    const patterns = clientUrls(({ path, loader: useLoader, loading }) => [
      path("/account/:id", AccountPage, () => [
        useLoader(AccountLoader),
        loading("Loading account"),
      ]),
    ]);

    expect(patterns.routes[0]).toEqual({
      id: "client-route-0",
      pattern: "/account/:id",
      name: undefined,
      options: undefined,
      component: AccountPage,
      layouts: [],
      layoutKeys: [],
      loaders: [{ loader: AccountLoader, revalidate: [] }],
      layoutLoaders: [],
      loading: "Loading account",
    });
  });

  it("keys each layout() by its ordinal among sibling layouts, shared by every route under it (#1124)", () => {
    function Shell(): null {
      return null;
    }
    function Inner(): null {
      return null;
    }
    // loading() and path() items don't count: adding one before a layout()
    // keeps its key.
    const patterns = clientUrls(({ layout, loading, path }) => [
      path("/", AccountPage),
      layout(Shell, () => [
        loading("Loading"),
        path("/a", AccountPage),
        path("/b", AccountPage),
        layout(Inner, () => [path("/c", AccountPage)]),
      ]),
      layout(Shell, () => [path("/d", AccountPage)]),
    ]);

    expect(patterns.routes.map((route) => route.layoutKeys)).toEqual([
      [],
      [0],
      [0],
      [0, 0],
      [1],
    ]);
  });

  it("stores the ssr flag from loader(Def, { ssr: false }, use?)", () => {
    const PlainLoader = loader("loaders#plain");
    const FlaggedLoader = loader("loaders#flagged");
    const FlaggedWithUse = loader("loaders#flagged-use");

    const patterns = clientUrls(({ path, loader: useLoader, revalidate }) => [
      path("/mixed", AccountPage, () => [
        useLoader(PlainLoader),
        useLoader(FlaggedLoader, { ssr: false }),
        useLoader(FlaggedWithUse, { ssr: false }, () => [
          revalidate(() => false),
        ]),
      ]),
    ]);

    const [route] = patterns.routes;
    expect(route.loaders[0]).toEqual({
      loader: PlainLoader,
      revalidate: [],
    });
    expect(route.loaders[1]).toMatchObject({
      loader: FlaggedLoader,
      ssr: false,
    });
    expect(route.loaders[2]).toMatchObject({
      loader: FlaggedWithUse,
      ssr: false,
    });
    expect(route.loaders[2].revalidate).toHaveLength(1);
  });

  it("rejects two use() callbacks, invalid ssr values, and the removed stream option", () => {
    const AccountLoader = loader("loaders#account");
    expect(() =>
      clientUrls(({ path, loader: useLoader }) => [
        path("/x", AccountPage, () => [
          useLoader(AccountLoader, (() => []) as never, () => []),
        ]),
      ]),
    ).toThrow(/two use\(\) callbacks/);
    expect(() =>
      clientUrls(({ path, loader: useLoader }) => [
        path("/x", AccountPage, () => [
          useLoader(AccountLoader, { ssr: "never" } as never),
        ]),
      ]),
    ).toThrow(/ssr must be a boolean/);
    expect(() =>
      clientUrls(({ path, loader: useLoader }) => [
        path("/x", AccountPage, () => [
          useLoader(AccountLoader, { stream: "navigation" } as never),
        ]),
      ]),
    ).toThrow(/stream was replaced.*ssr: false/);
  });

  // prefetch: false on a group route's loader (docs/design/prefetch-false.md,
  // R8 and "clientUrls() routes"): recorded on the route's loader record,
  // beside ssr, and projected onto the server stub from there.
  it("stores prefetch: false on the loader record, beside ssr; true records nothing", () => {
    const PriceLoader = loader("loaders#price");
    const ReviewsLoader = loader("loaders#reviews");
    const BothLoader = loader("loaders#both");
    const TrueLoader = loader("loaders#true");

    const patterns = clientUrls(({ path, loader: useLoader, revalidate }) => [
      path("/product/:slug", AccountPage, () => [
        useLoader(PriceLoader),
        useLoader(ReviewsLoader, { prefetch: false }, () => [
          revalidate(() => false),
        ]),
        useLoader(BothLoader, { ssr: false, prefetch: false }),
        useLoader(TrueLoader, { prefetch: true }),
      ]),
    ]);

    const [route] = patterns.routes;
    expect(route.loaders[0]).toEqual({ loader: PriceLoader, revalidate: [] });
    expect(route.loaders[1]).toMatchObject({
      loader: ReviewsLoader,
      prefetch: false,
    });
    expect(route.loaders[1].revalidate).toHaveLength(1);
    expect(route.loaders[1].ssr).toBeUndefined();
    expect(route.loaders[2]).toMatchObject({
      loader: BothLoader,
      ssr: false,
      prefetch: false,
    });
    expect(route.loaders[3]).toEqual({ loader: TrueLoader, revalidate: [] });
  });

  it("flags a layout() loader with prefetch: false on every route below it", () => {
    const ShellLoader = loader("loaders#shell");
    const PageLoader = loader("loaders#page");

    const patterns = clientUrls(({ path, layout, loader: useLoader }) => [
      layout(AccountLayout, () => [
        useLoader(ShellLoader, { prefetch: false }),
        path("/a", AccountPage, () => [useLoader(PageLoader)]),
        path("/b", SettingsPage),
      ]),
    ]);

    for (const route of patterns.routes) {
      expect(route.loaders[0]).toMatchObject({
        loader: ShellLoader,
        prefetch: false,
      });
    }
    expect(patterns.routes[0].loaders[1]).toEqual({
      loader: PageLoader,
      revalidate: [],
    });
  });

  it("rejects a prefetch value that is not a boolean", () => {
    const AccountLoader = loader("loaders#account");
    expect(() =>
      clientUrls(({ path, loader: useLoader }) => [
        path("/x", AccountPage, () => [
          useLoader(AccountLoader, { prefetch: "never" } as never),
        ]),
      ]),
    ).toThrow(/clientUrls\(\) loader\(\) prefetch must be a boolean/);
  });

  // A urls() intercept() takes loader(Def, { prefetch: false }) and ignores
  // it: an intercept prefetch defers nothing (R8). A clientUrls() intercept()
  // does the same: no rejection, and nothing recorded to project.
  it("records prefetch: false inside intercept(), as urls() does", () => {
    const DetailLoader = loader("loaders#detail");
    const PlainLoader = loader("loaders#plain");
    const patterns = clientUrls(({ path, intercept, loader: useLoader }) => [
      path("/items/:id", AccountPage, { name: "detail" }),
      intercept("@modal", ".detail", AccountLayout, () => [
        useLoader(DetailLoader, { prefetch: false }),
        useLoader(PlainLoader),
      ]),
    ]);

    expect(patterns.intercepts[0].loaders).toEqual([
      { loader: DetailLoader, revalidate: [], prefetch: false },
      { loader: PlainLoader, revalidate: [] },
    ]);
  });

  it("rejects ssr: false on intercept loaders", () => {
    const DetailLoader = loader("loaders#detail");
    expect(() =>
      clientUrls(({ path, intercept, loader: useLoader }) => [
        path("/items/:id", AccountPage, { name: "detail" }),
        intercept("@modal", ".detail", AccountLayout, () => [
          useLoader(DetailLoader, { ssr: false }),
        ]),
      ]),
    ).toThrow(/intercepts render on client navigations only/);
  });

  it("exposes only the supported helper and record shape", () => {
    expectTypeOf<keyof ClientUrlHelpers>().toEqualTypeOf<
      | "path"
      | "layout"
      | "loader"
      | "loading"
      | "intercept"
      | "transition"
      | "revalidate"
    >();
    expectTypeOf<
      Parameters<ClientUrlHelpers["loader"]>["length"]
    >().toEqualTypeOf<1 | 2 | 3>();
    expectTypeOf<keyof ClientUrlLoaderRecord>().toEqualTypeOf<
      "loader" | "revalidate" | "ssr" | "prefetch"
    >();
    expectTypeOf<keyof ClientUrlRouteRecord>().toEqualTypeOf<
      | "id"
      | "pattern"
      | "name"
      | "options"
      | "component"
      | "layouts"
      | "layoutKeys"
      | "loaders"
      | "layoutLoaders"
      | "loading"
      | "transition"
    >();
  });

  it("supports PathOptions, use-only, and options-plus-use overloads", () => {
    const DirectLoader = loader("loaders#direct");
    const ConfiguredLoader = loader("loaders#configured");

    const patterns = clientUrls(({ path, loader: useLoader, loading }) => [
      path("/direct", HomePage, () => [useLoader(DirectLoader)]),
      path(
        "/settings",
        SettingsPage,
        { name: "settings", trailingSlash: "never" },
        () => [useLoader(ConfiguredLoader), loading("Settings loading")],
      ),
    ]);

    expect(patterns.routes[0].options).toBeUndefined();
    expect(patterns.routes[0].loaders[0].loader).toBe(DirectLoader);
    expect(patterns.routes[1]).toMatchObject({
      name: "settings",
      options: { name: "settings", trailingSlash: "never" },
      loading: "Settings loading",
    });
    expect(patterns.routes[1].loaders[0].loader).toBe(ConfiguredLoader);
  });

  it("shares constraint and trailing-slash behavior with trie matching", () => {
    const patterns = clientUrls(({ path }) => [
      path("/:locale(en|gb)/docs", HomePage, {
        name: "docs",
        trailingSlash: "always",
      }),
    ]);

    expect(patterns.match("/en/docs")).toMatchObject({
      params: { locale: "en" },
      redirectTo: "/en/docs/",
    });
    expect(patterns.match("/gb/docs/")).toMatchObject({
      params: { locale: "gb" },
    });
    expect(patterns.match("/fr/docs")).toBeNull();
  });

  // The mount is the include() PATTERN. An absolute pathname matches
  // the routes joined to it, with the mount's params bound next to the
  // route's, as the server's match binds them.
  describe("match(pathname, mount): the include() mount pattern", () => {
    const patterns = clientUrls(({ path }) => [
      path("/", HomePage, { name: "index" }),
      path("/items/:itemId", UserPage, { name: "item" }),
    ]);

    it("a literal mount", () => {
      expect(patterns.match("/shop/items/1", "/shop")).toMatchObject({
        routeKey: "client-route-1",
        params: { itemId: "1" },
      });
      expect(patterns.match("/shop", "/shop")).toMatchObject({
        routeKey: "client-route-0",
        params: {},
      });
      expect(patterns.match("/elsewhere/items/1", "/shop")).toBeNull();
      expect(patterns.match("/shop-extra", "/shop")).toBeNull();
    });

    it("a required param mount", () => {
      expect(patterns.match("/en/items/1", "/:locale")).toMatchObject({
        routeKey: "client-route-1",
        params: { locale: "en", itemId: "1" },
      });
      expect(patterns.match("/de", "/:locale")).toMatchObject({
        routeKey: "client-route-0",
        params: { locale: "de" },
      });
      expect(patterns.match("/items/1", "/:locale")).toBeNull();
    });

    it("an optional param mount, with and without the prefix", () => {
      expect(patterns.match("/en/items/1", "/:locale?")).toMatchObject({
        routeKey: "client-route-1",
        params: { locale: "en", itemId: "1" },
      });
      const unprefixed = patterns.match("/items/1", "/:locale?");
      expect(unprefixed).toMatchObject({
        routeKey: "client-route-1",
        params: { itemId: "1" },
      });
      expect(unprefixed?.params).not.toHaveProperty("locale");
      expect(patterns.match("/", "/:locale?")).toMatchObject({
        routeKey: "client-route-0",
        params: {},
      });
      expect(patterns.match("/en", "/:locale?")).toMatchObject({
        routeKey: "client-route-0",
        params: { locale: "en" },
      });
    });

    it("nested params under a static prefix", () => {
      expect(
        patterns.match("/app/acme/web/items/6", "/app/:accountId/:projectId"),
      ).toMatchObject({
        routeKey: "client-route-1",
        params: { accountId: "acme", projectId: "web", itemId: "6" },
      });
      expect(
        patterns.match("/app/acme/items/6", "/app/:accountId/:projectId"),
      ).toBeNull();
    });
  });

  it("assigns deterministic route ids in flattened declaration order", () => {
    const build = (): ReturnType<typeof clientUrls> =>
      clientUrls(({ path, layout }) => [
        layout(AppLayout, () => [
          path("/", HomePage),
          path("/account", AccountPage),
        ]),
        path("/settings", SettingsPage),
      ]);

    expect(build().routes.map((route) => route.id)).toEqual([
      "client-route-0",
      "client-route-1",
      "client-route-2",
    ]);
    expect(build().routes.map((route) => route.id)).toEqual(
      build().routes.map((route) => route.id),
    );
  });

  it("rejects unsupported helpers and malformed nesting clearly", () => {
    for (const helperName of [
      "include",
      "parallel",
      "cache",
      "error",
      "notFound",
      "errorBoundary",
      "notFoundBoundary",
      "middleware",
    ]) {
      expect(() =>
        clientUrls(((helpers: ClientUrlHelpers) => {
          const unsupported = helpers as unknown as Record<
            string,
            () => ClientUrlItem
          >;
          return [unsupported[helperName]()];
        }) as ClientUrlBuilder),
      ).toThrow(`clientUrls() does not support ${helperName}()`);
    }

    expect(() =>
      clientUrls(({ path }) => [
        path("/", HomePage, () => [path("/nested", UserPage)]),
      ]),
    ).toThrow("does not support path() inside path()");
  });

  it("collects intercept records with self-contained loader and loading config", () => {
    const ItemLoader = loader("loaders#item");
    function DetailModal(): null {
      return null;
    }

    const patterns = clientUrls(
      ({ path, layout, intercept, loader: useLoader, loading }) => [
        layout(AppLayout, () => [
          path("/", HomePage, { name: "index" }),
          path("/detail/:id", AccountPage, { name: "detail" }),
          intercept("@modal", ".detail", DetailModal, () => [
            useLoader(ItemLoader),
            loading("Modal loading"),
          ]),
        ]),
      ],
    );

    expect(patterns.intercepts).toEqual([
      {
        slotName: "@modal",
        targetName: "detail",
        component: DetailModal,
        loaders: [{ loader: ItemLoader, revalidate: [] }],
        loading: "Modal loading",
      },
    ]);
    // Intercepts never become matchable routes.
    expect(patterns.routes).toHaveLength(2);
  });

  it("accepts top-level intercepts and defaults loaders/loading to empty", () => {
    function DetailModal(): null {
      return null;
    }

    const patterns = clientUrls(({ path, intercept }) => [
      path("/detail/:id", AccountPage, { name: "detail" }),
      intercept("@modal", ".detail", DetailModal),
    ]);

    expect(patterns.intercepts).toEqual([
      {
        slotName: "@modal",
        targetName: "detail",
        component: DetailModal,
        loaders: [],
        loading: undefined,
      },
    ]);
  });

  it("validates intercept arguments and target names", () => {
    function DetailModal(): null {
      return null;
    }

    expect(() =>
      clientUrls(({ path, intercept }) => [
        path("/detail/:id", AccountPage, { name: "detail" }),
        intercept("modal" as `@${string}`, ".detail", DetailModal),
      ]),
    ).toThrow('slot name must be a string beginning with "@"');

    expect(() =>
      clientUrls(({ path, intercept }) => [
        path("/detail/:id", AccountPage, { name: "detail" }),
        intercept("@modal", "detail" as `.${string}`, DetailModal),
      ]),
    ).toThrow('target must be a dot-local route name like ".detail"');

    expect(() =>
      clientUrls(({ path, intercept }) => [
        path("/detail/:id", AccountPage, { name: "detail" }),
        intercept("@modal", ".detail", (() => null) as never),
      ]),
    ).toThrow("intercept() expects a named client component value");

    expect(() =>
      clientUrls(({ path, intercept }) => [
        path("/detail/:id", AccountPage, { name: "detail" }),
        intercept("@modal", ".missing", DetailModal),
      ]),
    ).toThrow(
      'intercept() target ".missing" does not match a named path() in this definition',
    );

    // Unnamed routes cannot be targeted — names are the targeting contract.
    expect(() =>
      clientUrls(({ path, intercept }) => [
        path("/detail/:id", AccountPage),
        intercept("@modal", ".detail", DetailModal),
      ]),
    ).toThrow(
      'intercept() target ".detail" does not match a named path() in this definition',
    );
  });

  it("stores a data-only transition config on the route record", () => {
    const patterns = clientUrls(({ path, transition, loading }) => [
      path("/", HomePage, { name: "index" }),
      path("/detail/:id", AccountPage, { name: "detail" }, () => [
        loading("Detail loading"),
        transition({
          name: "detail-card",
          enter: "slide-in",
          exit: { navigation: "slide-out", "navigation-back": "slide-back" },
          viewTransition: "auto",
        }),
      ]),
    ]);

    expect(patterns.routes[0].transition).toBeUndefined();
    expect(patterns.routes[1].transition).toEqual({
      name: "detail-card",
      enter: "slide-in",
      exit: { navigation: "slide-out", "navigation-back": "slide-back" },
      viewTransition: "auto",
    });
  });

  it("validates transition config; `when` must be a function (it runs in the browser)", () => {
    const when = () => true;
    const accepted = clientUrls(({ path, transition }) => [
      path("/", HomePage, () => [transition({ when })]),
    ]);
    expect(accepted.routes[0]?.transition?.when).toBe(when);

    expect(() =>
      clientUrls(({ path, transition }) => [
        path("/", HomePage, () => [transition({ when: "yes" } as never)]),
      ]),
    ).toThrow(
      new TypeError(
        "clientUrls() transition() when must be a function (it runs in the browser), got string",
      ),
    );

    expect(() =>
      clientUrls(({ path, transition }) => [
        path("/", HomePage, () => [transition({ types: "x" } as never)]),
      ]),
    ).toThrow('transition() option "types" is not supported');

    expect(() =>
      clientUrls(({ path, transition }) => [
        path("/", HomePage, () => [
          transition({ viewTransition: true } as never),
        ]),
      ]),
    ).toThrow('transition() viewTransition must be "auto" or false');

    expect(() =>
      clientUrls(({ path, transition }) => [
        path("/", HomePage, () => [transition({ enter: 3 } as never)]),
      ]),
    ).toThrow(
      "transition() enter must be a string or a string map of transition types",
    );

    // Route position only: one per path, never at the top level or in layouts.
    expect(() =>
      clientUrls(({ path, transition }) => [
        path("/", HomePage, () => [
          transition({ name: "a" }),
          transition({ name: "b" }),
        ]),
      ]),
    ).toThrow("path() received more than one transition()");

    expect(() =>
      clientUrls(({ path, layout, transition }) => [
        layout(AppLayout, () => [
          path("/", HomePage),
          transition({ name: "layout-level" }),
        ]),
      ]),
    ).toThrow("does not support transition() inside layout()");

    expect(() =>
      clientUrls(({ path, transition }) => [
        path("/", HomePage),
        transition({ name: "top-level" }),
      ]),
    ).toThrow("does not support transition() inside clientUrls()");
  });

  it("restricts intercept use callbacks to loader() and loading()", () => {
    function DetailModal(): null {
      return null;
    }

    expect(() =>
      clientUrls(({ path, intercept }) => [
        path("/detail/:id", AccountPage, { name: "detail" }),
        intercept("@modal", ".detail", DetailModal, () => [
          path("/nested", HomePage),
        ]),
      ]),
    ).toThrow("does not support path() inside intercept()");
  });

  it("stores revalidate predicates per loader without executing them", () => {
    const SessionLoader = loader("loaders#session");
    const ItemLoader = loader("loaders#item");
    let predicateCalls = 0;
    const skipOnAction = () => {
      predicateCalls++;
      return false;
    };

    const patterns = clientUrls(
      ({ path, layout, loader: useLoader, revalidate }) => [
        layout(AppLayout, () => [
          useLoader(SessionLoader, () => [revalidate(skipOnAction)]),
          path("/items/:id", AccountPage, { name: "item" }, () => [
            useLoader(ItemLoader),
          ]),
        ]),
      ],
    );

    const [route] = patterns.routes;
    expect(
      route.loaders.map(({ loader: def, revalidate: fns }) => [
        def.$$id,
        fns.length,
      ]),
    ).toEqual([
      ["loaders#session", 1],
      ["loaders#item", 0],
    ]);
    expect(route.loaders[0].revalidate[0]).toBe(skipOnAction);
    expect(predicateCalls).toBe(0);
  });

  it("restricts revalidate() to loader use callbacks and validates the predicate", () => {
    expect(() =>
      clientUrls(({ path, loader: useLoader }) => [
        path("/", HomePage, () => [
          useLoader(loader("loaders#a"), () => [
            "nope" as unknown as ClientUrlItem,
          ]),
        ]),
      ]),
    ).toThrow("must return only client URL helper items");

    expect(() =>
      clientUrls(({ path, revalidate }) => [
        path("/", HomePage, () => [revalidate(() => true)]),
      ]),
    ).toThrow("does not support revalidate() inside path()");

    expect(() =>
      clientUrls(({ path, layout, revalidate }) => [
        layout(AppLayout, () => [path("/", HomePage), revalidate(() => true)]),
      ]),
    ).toThrow("does not support revalidate() inside layout()");

    expect(() =>
      clientUrls(({ path, revalidate }) => [
        path("/", HomePage),
        revalidate(() => true),
      ]),
    ).toThrow("does not support revalidate() inside clientUrls()");

    expect(() =>
      clientUrls(({ path, loader: useLoader, revalidate }) => [
        path("/", HomePage, () => [
          useLoader(loader("loaders#a"), () => [revalidate("nope" as never)]),
        ]),
      ]),
    ).toThrow("revalidate() expects a predicate function");

    expect(() =>
      clientUrls(({ path, loader: useLoader, revalidate }) => [
        path("/", HomePage, () => [
          useLoader(loader("loaders#a"), () => [
            revalidate({ $$rangoRevalidate: 1 } as never),
          ]),
        ]),
      ]),
    ).toThrow("revalidate() expects a predicate function");

    expect(() =>
      clientUrls(({ path, loader: useLoader, loading }) => [
        path("/", HomePage, () => [
          useLoader(loader("loaders#a"), () => [loading("no")]),
        ]),
      ]),
    ).toThrow("does not support loading() inside loader()");
  });

  it("stores revalidate(true | false) as the boolean, in declaration order with predicates", () => {
    const onAction = () => undefined;
    const patterns = clientUrls(
      ({ path, layout, loader: useLoader, revalidate, intercept }) => [
        layout(AppLayout, () => [
          useLoader(loader("loaders#held"), () => [revalidate(false)]),
          path("/", HomePage, { name: "home" }, () => [
            useLoader(loader("loaders#chain"), () => [
              revalidate(true),
              revalidate(onAction),
            ]),
          ]),
          path("/detail", AccountPage, { name: "detail" }),
          intercept("@modal", ".detail", AccountPage, () => [
            useLoader(loader("loaders#modal"), () => [revalidate(false)]),
          ]),
        ]),
      ],
    );
    expect(
      patterns.routes[0].loaders.map(({ revalidate: fns }) => fns),
    ).toEqual([[false], [true, onAction]]);
    expect(patterns.intercepts[0].loaders[0].revalidate).toEqual([false]);
  });

  it("rejects a revalidate() argument that is neither a predicate nor a boolean, outside production", () => {
    for (const value of [undefined, null, 0, "true"]) {
      expect(() =>
        clientUrls(({ path, loader: useLoader, revalidate }) => [
          path("/", HomePage, () => [
            useLoader(loader("loaders#a"), () => [revalidate(value as never)]),
          ]),
        ]),
      ).toThrow(
        "clientUrls() revalidate() expects a predicate function or a boolean",
      );
    }
    // A production build rejected it at its call site (the hoist plugin), so
    // the browser bundle skips the check.
    vi.stubEnv("NODE_ENV", "production");
    try {
      expect(() =>
        clientUrls(({ path, loader: useLoader, revalidate }) => [
          path("/", HomePage, () => [
            useLoader(loader("loaders#a"), () => [revalidate(null as never)]),
          ]),
        ]),
      ).not.toThrow();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("keeps the marker the build leaves in place of a hoisted predicate", () => {
    const hoisted = { $$rangoRevalidate: "k1" };
    const patterns = clientUrls(({ path, loader: useLoader, revalidate }) => [
      path("/", HomePage, () => [
        useLoader(loader("loaders#a"), () => [revalidate(hoisted as never)]),
      ]),
    ]);
    expect(patterns.routes[0].loaders[0].revalidate).toEqual([hoisted]);
  });

  it("rejects malformed values instead of executing them", () => {
    expect(() =>
      clientUrls(({ path }) => [
        path("/", HomePage, () => [{} as ClientUrlItem]),
      ]),
    ).toThrow("must return only client URL helper items");

    expect(() =>
      clientUrls(({ layout, loading }) => [
        layout(AppLayout, () => [loading("No route")]),
      ]),
    ).toThrow("layout() children must contain at least one path()");

    expect(() =>
      clientUrls((() => null) as unknown as ClientUrlBuilder),
    ).toThrow("builder callback must return an array");
  });
});

describe("clientUrls(): a mounted component's own use items (Component.use)", () => {
  /** A named page component carrying `use`, as an app writes one. */
  function withUse(name: string, use: unknown): ComponentType {
    const component = { [name]: () => null }[name] as ComponentType & {
      use?: unknown;
    };
    component.use = use;
    return component;
  }

  it("the global helpers are the functions the builder hands out", () => {
    let handed: ClientUrlHelpers | undefined;
    clientUrls((helpers) => {
      handed = helpers;
      return [helpers.path("/", HomePage)];
    });
    expect(handed!.loader).toBe(globalLoader);
    expect(handed!.loading).toBe(globalLoading);
    expect(handed!.revalidate).toBe(globalRevalidate);
    expect(handed!.transition).toBe(globalTransition);
  });

  it("path(): the component's items come first; loaders accumulate, an explicit loading() and transition() win", () => {
    const Stats = loader("loaders#stats");
    const Own = loader("loaders#own");
    const predicate = () => true;
    const Dashboard = withUse("Dashboard", () => [
      globalLoader(Stats, () => [globalRevalidate(predicate)]),
      globalLoading("component skeleton"),
      globalTransition({ name: "from-component" }),
    ]);

    const merged = clientUrls(
      ({ path, loader: useLoader, loading, transition }) => [
        path("/dash", Dashboard, () => [
          useLoader(Own),
          loading("explicit skeleton"),
          transition({ name: "explicit" }),
        ]),
        path("/plain", Dashboard),
      ],
    );
    const [dash, plain] = merged.routes;
    expect(dash!.loaders).toEqual([
      { loader: Stats, revalidate: [predicate] },
      { loader: Own, revalidate: [] },
    ]);
    expect(dash!.loading).toBe("explicit skeleton");
    expect(dash!.transition).toEqual({ name: "explicit" });

    // Alone, the component's own items apply; each mount site gets its own
    // records.
    expect(plain!.loaders).toEqual([
      { loader: Stats, revalidate: [predicate] },
    ]);
    expect(plain!.loaders[0]).not.toBe(dash!.loaders[0]);
    expect(plain!.loading).toBe("component skeleton");
    expect(plain!.transition).toEqual({ name: "from-component" });
  });

  it("layout(): the component's loaders are layout loaders, one record shared by every route below it", () => {
    const Cart = loader("loaders#cart");
    const Auth = loader("loaders#auth");
    const Shell = withUse("Shell", () => [
      globalLoader(Cart),
      globalLoading("shell skeleton"),
    ]);
    const patterns = clientUrls(({ layout, path, loader: useLoader }) => [
      layout(Shell, () => [
        useLoader(Auth),
        path("/a", HomePage),
        path("/b", UserPage),
      ]),
    ]);
    const [a, b] = patterns.routes;
    expect(a!.loaders.map((record) => record.loader)).toEqual([Cart, Auth]);
    expect(a!.layoutLoaders).toEqual(a!.loaders);
    expect(a!.layoutLoaders[0]).toBe(b!.layoutLoaders[0]);
    expect(a!.layoutLoaders[1]).toBe(b!.layoutLoaders[1]);
    expect(a!.loading).toBe("shell skeleton");

    const overridden = clientUrls(({ layout, path, loading }) => [
      layout(Shell, () => [loading("explicit"), path("/a", HomePage)]),
    ]);
    expect(overridden.routes[0]!.loading).toBe("explicit");
  });

  it("intercept(): the component's loaders and loading() join the intercept's", () => {
    const Modal = loader("loaders#modal");
    const Own = loader("loaders#own");
    const ItemModal = withUse("ItemModal", () => [
      globalLoader(Modal, { prefetch: false }),
      globalLoading("modal skeleton"),
    ]);
    const patterns = clientUrls(({ path, intercept, loader: useLoader }) => [
      path("/items/:id", UserPage, { name: "item" }),
      intercept("@modal", ".item", ItemModal, () => [useLoader(Own)]),
    ]);
    expect(patterns.intercepts[0]!.loaders).toEqual([
      { loader: Modal, revalidate: [], prefetch: false },
      { loader: Own, revalidate: [] },
    ]);
    expect(patterns.intercepts[0]!.loading).toBe("modal skeleton");

    const ssr = withUse("SsrModal", () => [
      globalLoader(Modal, { ssr: false }),
    ]);
    expect(() =>
      clientUrls(({ path, intercept }) => [
        path("/items/:id", UserPage, { name: "item" }),
        intercept("@modal", ".item", ssr),
      ]),
    ).toThrow("intercept() loaders cannot use ssr: false");
  });

  it("validates the component's items for its mount site, naming the component", () => {
    const Page = withUse("Dashboard", () => [
      clientUrls(({ path }) => [path("/x", HomePage)]).routes as never,
    ]);
    expect(() => clientUrls(({ path }) => [path("/", Page)])).toThrow(
      "clientUrls() Dashboard.use callback must return only client URL helper items",
    );

    // Structural items: routes come from the builder's own items.
    let nested: unknown;
    clientUrls((helpers) => {
      nested = helpers.path("/nested", HomePage);
      return [helpers.path("/", HomePage)];
    });
    const Structural = withUse("Dashboard", () => [nested]);
    expect(() => clientUrls(({ path }) => [path("/", Structural)])).toThrow(
      "clientUrls() does not support path() inside Dashboard.use: routes come from the clientUrls() builder's own items",
    );

    // A layout component carries loader() and loading() only.
    const Shell = withUse("Shell", () => [globalTransition({ name: "x" })]);
    expect(() =>
      clientUrls(({ layout, path }) => [
        layout(Shell, () => [path("/", HomePage)]),
      ]),
    ).toThrow("clientUrls() does not support transition() inside Shell.use()");

    // A revalidate() belongs inside a loader's use callback.
    const Loose = withUse("Loose", () => [globalRevalidate(true)]);
    expect(() => clientUrls(({ path }) => [path("/", Loose)])).toThrow(
      "clientUrls() does not support revalidate() inside Loose.use()",
    );

    expect(() =>
      clientUrls(({ path }) => [path("/", withUse("NotAFunction", [1]))]),
    ).toThrow("clientUrls() NotAFunction.use expects a callback");
    expect(() =>
      clientUrls(({ path }) => [
        path(
          "/",
          withUse("NoArray", () => null),
        ),
      ]),
    ).toThrow("clientUrls() NoArray.use callback must return an array");

    // One transition() per list; one in each is a merge, not an error.
    const Twice = withUse("Twice", () => [
      globalTransition({ name: "a" }),
      globalTransition({ name: "b" }),
    ]);
    expect(() => clientUrls(({ path }) => [path("/", Twice)])).toThrow(
      "clientUrls() path() received more than one transition()",
    );
    // The count is a dev check: a production bundle keeps the last one, as
    // the server's handler.use merge does.
    vi.stubEnv("NODE_ENV", "production");
    try {
      const twice = clientUrls(({ path, transition }) => [
        path("/", Twice),
        path("/b", HomePage, () => [
          transition({ name: "c" }),
          transition({ name: "d" }),
        ]),
      ]);
      expect(twice.routes.map((route) => route.transition)).toEqual([
        { name: "b" },
        { name: "d" },
      ]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("calls the component's use once per mount site, never at render", () => {
    const use = vi.fn(() => [globalLoading("skeleton")]);
    const Page = withUse("Page", use);
    clientUrls(({ path }) => [path("/a", Page), path("/b", Page)]);
    expect(use).toHaveBeenCalledTimes(2);
  });
});
