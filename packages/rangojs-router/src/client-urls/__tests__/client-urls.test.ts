import { describe, expect, expectTypeOf, it } from "vitest";
import {
  clientUrls,
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
      loaders: [{ loader: AccountLoader, revalidate: [] }],
      loading: "Loading account",
    });
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
      "loader" | "revalidate" | "ssr"
    >();
    expectTypeOf<keyof ClientUrlRouteRecord>().toEqualTypeOf<
      | "id"
      | "pattern"
      | "name"
      | "options"
      | "component"
      | "layouts"
      | "loaders"
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

  it("validates transition config and rejects the server-only when gate", () => {
    expect(() =>
      clientUrls(({ path, transition }) => [
        path("/", HomePage, () => [transition({ when: () => true } as never)]),
      ]),
    ).toThrow(
      "transition() does not support `when` — the gate is a server-executed predicate",
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

  it("stores client-run revalidate predicates per loader without executing them", () => {
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
      clientUrls(({ path, loader: useLoader, loading }) => [
        path("/", HomePage, () => [
          useLoader(loader("loaders#a"), () => [loading("no")]),
        ]),
      ]),
    ).toThrow("does not support loading() inside loader()");
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
