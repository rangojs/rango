import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildRouteTrie } from "../../build/route-trie.js";
import { tryTrieMatch } from "../../router/trie-matching.js";
import {
  RangoContext,
  runWithPrefixes,
  type EntryData,
} from "../../server/context.js";
import type {
  LoaderContext,
  LoaderDefinition,
  RevalidateParams,
  ShouldRevalidateFn,
} from "../../types.js";
import type { PathOptions } from "../../urls/pattern-types.js";
import { createRouter, toInternal } from "../../router.js";
import { urls } from "../../urls/urls-function.js";
import { generateManifestFull } from "../../build/generate-manifest.js";
import {
  ClientUrlsInterceptSlot,
  ClientUrlsLoading,
  ClientUrlsRoot,
} from "../client-root.js";
import { clientUrls } from "../client-urls.js";
import {
  clearClientUrlProjections,
  getClientUrlProjection,
  isClientUrlReference,
  isClientUrlPatterns,
  materializeClientUrlPatterns,
  serializeClientUrlPatterns,
  setClientUrlProjection,
  type ClientUrlProjection,
  type ClientUrlReference,
} from "../server-projection.js";
import {
  clearClientUrlRevalidators,
  registerClientUrlRevalidators,
} from "../revalidate-registry.js";
import { runRevalidate } from "../../testing/run-revalidate.js";

const { getLoaderLazyMock } = vi.hoisted(() => ({
  getLoaderLazyMock: vi.fn(),
}));

vi.mock("../../server/loader-registry.js", () => ({
  getLoaderLazy: getLoaderLazyMock,
}));

function AppLayout(): null {
  return null;
}

function AccountPage(): null {
  return null;
}

function loaderDefinition(id: string): LoaderDefinition<unknown> {
  return { __brand: "loader", $$id: id };
}

function clientReference(id: string): ClientUrlReference {
  return Object.assign(
    function ClientUrlDefinition(): null {
      return null;
    },
    {
      $$typeof: Symbol.for("react.client.reference"),
      $$id: id,
    },
  ) as unknown as ClientUrlReference;
}

function materializedLoaderDefinition(id: string): LoaderDefinition<unknown> {
  const source = clientUrls(({ path, loader }) => [
    path("/dynamic", AccountPage, { name: "dynamic" }, () => [
      loader(loaderDefinition(id)),
    ]),
  ]);
  const materialized = materializeClientUrlPatterns(
    clientReference("app.urls#dynamic"),
    serializeClientUrlPatterns(source),
  );
  const manifest = new Map<string, EntryData>();

  RangoContext.run(
    {
      manifest,
      patterns: new Map(),
      trailingSlash: new Map(),
      searchSchemas: new Map(),
      namespace: "test",
      parent: null,
      counters: {},
    },
    () => materialized.handler(),
  );

  const entry = manifest.get("dynamic");
  if (!entry || entry.type !== "route" || !entry.loader[0]) {
    throw new Error("Expected the projected dynamic route loader");
  }
  return entry.loader[0].loader;
}

afterEach(() => {
  clearClientUrlProjections();
  clearClientUrlRevalidators();
  getLoaderLazyMock.mockReset();
});

describe("client URL server projection", () => {
  it("serializes deterministic JSON-safe route records without browser components", () => {
    const SessionLoader = loaderDefinition("loaders#session");
    const AccountLoader = loaderDefinition("loaders#account");
    const patterns = clientUrls(({ layout, path, loader, loading }) => [
      layout(AppLayout, () => [
        loader(SessionLoader),
        loading("Layout loading"),
        path(
          "/accounts/:id",
          AccountPage,
          {
            name: "account",
            search: { tab: "string?", active: "boolean" },
            trailingSlash: "never",
          },
          () => [loader(AccountLoader), loading("Account loading")],
        ),
      ]),
    ]);

    const projection = serializeClientUrlPatterns(patterns);

    expect(projection).toEqual({
      version: 1,
      routes: [
        {
          id: "client-route-0",
          pattern: "/accounts/:id",
          name: "account",
          options: {
            search: { active: "boolean", tab: "string?" },
            trailingSlash: "never",
          },
          loaderIds: ["loaders#session", "loaders#account"],
          hasLoading: true,
        },
      ],
      intercepts: [],
    });
    expect(JSON.parse(JSON.stringify(projection))).toEqual(projection);
    expect(JSON.stringify(serializeClientUrlPatterns(patterns))).toBe(
      JSON.stringify(projection),
    );
    expect(JSON.stringify(projection)).not.toContain("AppLayout");
    expect(JSON.stringify(projection)).not.toContain("AccountPage");
    expect(isClientUrlPatterns(patterns)).toBe(true);
    expect(isClientUrlPatterns(projection)).toBe(false);
  });

  it("serializes awaitedLoaderIndices and materializes awaitBeforeFlush on SSR entries only", () => {
    const StreamingLoader = loaderDefinition("loaders#streaming");
    const FlaggedLoader = loaderDefinition("loaders#flagged");
    const source = clientUrls(({ path, loader }) => [
      path("/mixed", AccountPage, { name: "mixed" }, () => [
        loader(StreamingLoader),
        loader(FlaggedLoader, { ssr: false }),
      ]),
    ]);

    const projection = serializeClientUrlPatterns(source);
    expect(projection.routes[0]!.awaitedLoaderIndices).toEqual([1]);
    // Still a JSON-safe artifact — it is baked into generated virtual modules.
    expect(JSON.parse(JSON.stringify(projection))).toEqual(projection);

    const materialized = materializeClientUrlPatterns(
      clientReference("app.urls#mixed"),
      projection,
    );
    const materializeLoaders = (isSSR: boolean) => {
      const manifest = new Map<string, EntryData>();
      RangoContext.run(
        {
          manifest,
          patterns: new Map(),
          trailingSlash: new Map(),
          searchSchemas: new Map(),
          namespace: "test",
          parent: null,
          counters: {},
          isSSR,
        },
        () => materialized.handler(),
      );
      const entry = manifest.get("mixed");
      if (!entry || entry.type !== "route") {
        throw new Error("Expected the projected mixed route");
      }
      return entry.loader;
    };

    const ssrLoaders = materializeLoaders(true);
    expect(ssrLoaders[0]!.awaitBeforeFlush).toBeUndefined();
    expect(ssrLoaders[1]!.awaitBeforeFlush).toBe(true);

    // Navigation-lane evaluation never carries the flag — streaming stays on.
    const navLoaders = materializeLoaders(false);
    expect(navLoaders[1]!.awaitBeforeFlush).toBeUndefined();
  });

  // prefetch: false crosses the client/server projection as indices, beside
  // awaitedLoaderIndices, and lands on the materialized stub's LoaderEntry,
  // which is what the server's deferral scope reads
  // (router/segment-resolution/prefetch-deferral.ts).
  it("serializes deferrableLoaderIndices and materializes prefetch: false on the stub entry", () => {
    function DetailModal(): null {
      return null;
    }
    const source = clientUrls(({ path, layout, intercept, loader }) => [
      layout(AppLayout, () => [
        loader(loaderDefinition("loaders#shell"), { prefetch: false }),
        path("/product/:slug", AccountPage, { name: "product" }, () => [
          loader(loaderDefinition("loaders#price")),
          loader(loaderDefinition("loaders#reviews"), { prefetch: false }),
          loader(loaderDefinition("loaders#both"), {
            ssr: false,
            prefetch: false,
          }),
        ]),
        path("/plain", AccountPage, { name: "plain" }, () => [
          loader(loaderDefinition("loaders#plain")),
        ]),
      ]),
      intercept("@modal", ".product", DetailModal, () => [
        loader(loaderDefinition("loaders#modal"), { prefetch: false }),
      ]),
    ]);

    const projection = serializeClientUrlPatterns(source);
    const [product, plain] = projection.routes;
    expect(product!.loaderIds).toEqual([
      "loaders#shell",
      "loaders#price",
      "loaders#reviews",
      "loaders#both",
    ]);
    expect(product!.deferrableLoaderIndices).toEqual([0, 2, 3]);
    expect(product!.awaitedLoaderIndices).toEqual([3]);
    // The layout's flagged loader flattens onto every route below it.
    expect(plain!.deferrableLoaderIndices).toEqual([0]);
    // An intercept's flagged loader projects as a route's does.
    expect(projection.intercepts![0]!.deferrableLoaderIndices).toEqual([0]);
    expect(JSON.parse(JSON.stringify(projection))).toEqual(projection);

    // A projection serialized before the option existed has no field.
    const unflagged = serializeClientUrlPatterns(
      clientUrls(({ path, loader }) => [
        path("/x", AccountPage, () => [loader(loaderDefinition("loaders#x"))]),
      ]),
    );
    expect("deferrableLoaderIndices" in unflagged.routes[0]!).toBe(false);

    const manifest = new Map<string, EntryData>();
    RangoContext.run(
      {
        manifest,
        patterns: new Map(),
        trailingSlash: new Map(),
        searchSchemas: new Map(),
        namespace: "test",
        parent: null,
        counters: {},
        isSSR: false,
      },
      () =>
        materializeClientUrlPatterns(
          clientReference("app.urls#deferrable"),
          projection,
        ).handler(),
    );
    const entry = manifest.get("product");
    if (!entry || entry.type !== "route") {
      throw new Error("Expected the projected product route");
    }
    expect(
      entry.loader.map((loaderEntry) => ({
        id: loaderEntry.loader.$$id,
        prefetch: loaderEntry.prefetch,
        bake: loaderEntry.bake,
      })),
    ).toEqual([
      { id: "loaders#shell", prefetch: false, bake: undefined },
      { id: "loaders#price", prefetch: undefined, bake: undefined },
      { id: "loaders#reviews", prefetch: false, bake: undefined },
      { id: "loaders#both", prefetch: false, bake: true },
    ]);
    const groupLayout = entry.parent!;
    const interceptEntry = groupLayout.intercept[0]!;
    expect(interceptEntry.loader.map((l) => l.prefetch)).toEqual([false]);
  });

  it("projects ppr (true and JSON config), rejects malformed ppr values", () => {
    // The boolean form projects verbatim.
    const boolProjection = serializeClientUrlPatterns(
      clientUrls(({ path }) => [path("/ppr", AccountPage, { ppr: true })]),
    );
    expect(boolProjection.routes[0]!.options.ppr).toBe(true);

    // The object form projects as a frozen JSON copy — mutating the source
    // options after definition must not leak into the projection.
    const pprConfig = { ttl: 300, swr: 120, tags: ["shop"] };
    const objProjection = serializeClientUrlPatterns(
      clientUrls(({ path }) => [path("/ppr", AccountPage, { ppr: pprConfig })]),
    );
    const projected = objProjection.routes[0]!.options.ppr;
    expect(projected).toEqual({ ttl: 300, swr: 120, tags: ["shop"] });
    expect(projected).not.toBe(pprConfig);
    expect(Object.isFrozen(projected)).toBe(true);
    pprConfig.ttl = 1;
    expect((projected as { ttl: number }).ttl).toBe(300);

    // Non-JSON values fail before a projection exists (DSL validation runs
    // first; the projection serializer re-validates the same shape).
    const badPpr = { ppr: { ttl: Infinity } } as unknown as PathOptions;
    expect(() =>
      serializeClientUrlPatterns(
        clientUrls(({ path }) => [path("/ppr", AccountPage, badPpr)]),
      ),
    ).toThrow(/ppr\.ttl"? must be a finite number/);
  });

  it("rejects unsupported options and missing loader ids", () => {
    const unsupportedOptions = {
      analytics: true,
    } as unknown as PathOptions;
    expect(() =>
      serializeClientUrlPatterns(
        clientUrls(({ path }) => [
          path("/unsupported", AccountPage, unsupportedOptions),
        ]),
      ),
    ).toThrow(/path option "analytics" is not supported/);

    // Locked composition limits: these capabilities belong to the server tree
    // and must not smuggle in through cast option objects either. (The
    // unsupported DSL helpers are separately rejected — client-urls.test.ts
    // pins every entry of UNSUPPORTED_HELPERS.)
    for (const key of ["intercept", "parallel", "revalidate"]) {
      const smuggled = { [key]: true } as unknown as PathOptions;
      expect(() =>
        serializeClientUrlPatterns(
          clientUrls(({ path }) => [path("/limit", AccountPage, smuggled)]),
        ),
      ).toThrow(new RegExp(`path option "${key}" is not supported`));
    }

    expect(() =>
      serializeClientUrlPatterns(
        clientUrls(({ path, loader }) => [
          path("/missing-loader-id", AccountPage, () => [
            loader(loaderDefinition("")),
          ]),
        ]),
      ),
    ).toThrow(/loader at index 0 is missing a non-empty \$\$id/);
  });

  it("recognizes React client references and keys the process registry by $$id", () => {
    const firstReference = clientReference("app.urls#default");
    const equivalentReference = clientReference("app.urls#default");
    const projection = serializeClientUrlPatterns(
      clientUrls(({ path }) => [path("/", AccountPage)]),
    );

    expect(isClientUrlReference(firstReference)).toBe(true);
    expect(
      isClientUrlReference({
        $$typeof: Symbol.for("react.client.reference"),
        $$id: "object-reference",
      }),
    ).toBe(true);
    expect(isClientUrlReference({ $$id: "missing-marker" })).toBe(false);
    expect(isClientUrlReference(null)).toBe(false);

    setClientUrlProjection(firstReference, projection);
    expect(getClientUrlProjection(equivalentReference)).toBe(projection);
    expect(getClientUrlProjection("app.urls#default")).toBe(projection);

    // HMR: after an update vite stamps the module id with a `?t=<timestamp>`
    // (or `&t=` behind existing queries); the include's client reference then
    // carries the stamped $$id while the projection was registered under the
    // bare id. The key funnel strips ONLY the t-param — this lookup missing
    // meant every request 500'd until a server restart.
    expect(getClientUrlProjection("app.urls?t=1784988833465#default")).toBe(
      projection,
    );
    expect(
      getClientUrlProjection({
        $$typeof: Symbol.for("react.client.reference"),
        $$id: "app.urls?t=99#default",
      } as never),
    ).toBe(projection);
    const queried = { routes: [], intercepts: [] } as never;
    setClientUrlProjection("mod?v=abc&t=5#default", queried);
    expect(getClientUrlProjection("mod?v=abc#default")).toBe(queried);

    clearClientUrlProjections();
    expect(getClientUrlProjection(firstReference)).toBeUndefined();
  });

  it("materializes ordinary paths with preserved matching, loaders, and loading", () => {
    const SessionLoader = loaderDefinition("loaders#session");
    const AccountLoader = loaderDefinition("loaders#account");
    const source = clientUrls(({ path, loader, loading }) => [
      path(
        "/accounts/:id",
        AccountPage,
        {
          name: "account",
          search: { tab: "string?" },
          trailingSlash: "always",
        },
        () => [
          loader(SessionLoader),
          loader(AccountLoader),
          loading("Account loading"),
        ],
      ),
    ]);
    const reference = clientReference("app.urls#default");
    const materialized = materializeClientUrlPatterns(
      reference,
      serializeClientUrlPatterns(source),
    );
    const manifest = new Map<string, EntryData>();
    const routePatterns = new Map<string, string>();
    const trailingSlash = new Map<string, "never" | "always" | "ignore">();
    const searchSchemas = new Map<string, Record<string, string>>();

    RangoContext.run(
      {
        manifest,
        patterns: routePatterns,
        trailingSlash,
        searchSchemas,
        namespace: "test",
        parent: null,
        counters: {},
      },
      () => materialized.handler(),
    );

    const entry = manifest.get("account");
    expect(entry?.type).toBe("route");
    if (!entry || entry.type !== "route") {
      throw new Error("Expected the projected account route");
    }

    expect(routePatterns).toEqual(new Map([["account", "/accounts/:id"]]));
    expect(trailingSlash.get("account")).toBe("always");
    expect(searchSchemas.get("account")).toEqual({ tab: "string?" });
    expect(
      entry.loader.map(({ loader }) => ({
        __brand: loader.__brand,
        $$id: loader.$$id,
        hasFn: typeof loader.fn === "function",
      })),
    ).toEqual([
      { __brand: "loader", $$id: "loaders#session", hasFn: true },
      { __brand: "loader", $$id: "loaders#account", hasFn: true },
    ]);

    const handlerElement = (
      entry.handler as unknown as () => React.ReactElement
    )();
    expect(handlerElement.type).toBe(ClientUrlsRoot);
    expect(handlerElement.props).toEqual({
      definition: reference,
      routeId: "client-route-0",
    });

    expect(React.isValidElement(entry.loading)).toBe(true);
    const loadingElement = entry.loading as React.ReactElement<{
      definition: ClientUrlReference;
      routeId: string;
    }>;
    expect(loadingElement.type).toBe(ClientUrlsLoading);
    expect(loadingElement.props).toEqual({
      definition: reference,
      routeId: "client-route-0",
    });

    const routeManifest = Object.fromEntries(routePatterns);
    const staticPrefixes = Object.fromEntries(
      Object.keys(routeManifest).map((name) => [name, ""]),
    );
    const trie = buildRouteTrie(
      routeManifest,
      staticPrefixes,
      Object.fromEntries(trailingSlash),
    );
    expect(tryTrieMatch(trie, "/accounts/42")).toMatchObject({
      routeKey: "account",
      params: { id: "42" },
      redirectTo: "/accounts/42/",
    });
  });

  it("serializes intercept records as JSON-safe data without components", () => {
    function DetailModal(): null {
      return null;
    }
    const ItemLoader = loaderDefinition("loaders#item");
    const patterns = clientUrls(({ path, intercept, loader, loading }) => [
      path("/", AccountPage, { name: "index" }),
      path("/detail/:id", AccountPage, { name: "detail" }),
      intercept("@modal", ".detail", DetailModal, () => [
        loader(ItemLoader),
        loading("Modal loading"),
      ]),
    ]);

    const projection = serializeClientUrlPatterns(patterns);
    expect(projection.intercepts).toEqual([
      {
        slotName: "@modal",
        targetName: "detail",
        loaderIds: ["loaders#item"],
        hasLoading: true,
      },
    ]);
    expect(JSON.parse(JSON.stringify(projection))).toEqual(projection);
    expect(JSON.stringify(projection)).not.toContain("DetailModal");
  });

  it("attaches materialized intercepts to a group layout entry, not the module parent", () => {
    // Attachment contract (scar tissue): findInterceptForRoute walks the
    // TARGET route's parent chain, and intercepts emitted at the TOP LEVEL of
    // a lazily included module attach to the isolated parent clone
    // (getIsolatedLazyParent) and are silently discarded. Materialization must
    // therefore wrap the group in one layout entry that (a) owns the
    // intercepts so the target chain reaches them, (b) hosts the slot outlets
    // so the modal renders inside the group subtree, and (c) leaves the module
    // parent's intercept array untouched.
    function DetailModal(): null {
      return null;
    }
    const source = clientUrls(({ path, intercept, loader, loading }) => [
      path("/", AccountPage, { name: "index" }),
      path("/detail/:id", AccountPage, { name: "detail" }),
      intercept("@modal", ".detail", DetailModal, () => [
        loader(loaderDefinition("loaders#item")),
        loading("Modal loading"),
      ]),
    ]);
    const reference = clientReference("app.urls#intercepts");
    const materialized = materializeClientUrlPatterns(
      reference,
      serializeClientUrlPatterns(source),
    );

    const manifest = new Map<string, EntryData>();
    const moduleParent = {
      id: "test.module-parent",
      shortCode: "P0",
      type: "layout",
      parent: null,
      handler: () => null,
      loader: [],
      middleware: [],
      revalidate: [],
      errorBoundary: [],
      notFoundBoundary: [],
      layout: [],
      parallel: {},
      intercept: [],
    } as unknown as EntryData;

    RangoContext.run(
      {
        manifest,
        patterns: new Map(),
        trailingSlash: new Map(),
        searchSchemas: new Map(),
        namespace: "test",
        parent: moduleParent,
        counters: {},
      },
      () => materialized.handler(),
    );

    const index = manifest.get("index");
    const detail = manifest.get("detail");
    if (!index || !detail) throw new Error("Expected materialized routes");

    // Both routes share ONE group layout entry; the module parent is its parent.
    const groupLayout = index.parent;
    expect(groupLayout?.type).toBe("layout");
    expect(detail.parent).toBe(groupLayout);
    expect(groupLayout?.parent).toBe(moduleParent);

    // The intercept lives on the group layout — and ONLY there.
    expect(moduleParent.intercept).toEqual([]);
    expect(groupLayout?.intercept).toHaveLength(1);
    const interceptEntry = groupLayout!.intercept[0];
    expect(interceptEntry.slotName).toBe("@modal");
    expect(interceptEntry.routeName).toBe("detail");
    // The target-chain walk is origin-blind, so materialization synthesizes
    // the module-local origin check as a `when` selector. At the root mount
    // ("/") every origin is in-group.
    expect(interceptEntry.when).toHaveLength(1);
    expect(
      interceptEntry.when[0]({
        from: { url: new URL("http://localhost/anywhere"), params: {} },
      } as Parameters<(typeof interceptEntry.when)[0]>[0]),
    ).toBe(true);
    expect(
      interceptEntry.loader.map(({ loader }) => ({
        $$id: loader.$$id,
        hasFn: typeof loader.fn === "function",
      })),
    ).toEqual([{ $$id: "loaders#item", hasFn: true }]);

    // Slot handler renders the definition's modal via ClientUrlsInterceptSlot.
    const slotElement = (
      interceptEntry.handler as unknown as () => React.ReactElement
    )();
    expect(slotElement.type).toBe(ClientUrlsInterceptSlot);
    expect(slotElement.props).toEqual({
      definition: reference,
      interceptIndex: 0,
    });

    // A definition WITHOUT intercepts keeps the flat shape: no wrapper layout.
    const flatSource = clientUrls(({ path }) => [
      path("/", AccountPage, { name: "flat" }),
    ]);
    const flatManifest = new Map<string, EntryData>();
    RangoContext.run(
      {
        manifest: flatManifest,
        patterns: new Map(),
        trailingSlash: new Map(),
        searchSchemas: new Map(),
        namespace: "test",
        parent: moduleParent,
        counters: {},
      },
      () =>
        materializeClientUrlPatterns(
          clientReference("app.urls#flat"),
          serializeClientUrlPatterns(flatSource),
        ).handler(),
    );
    expect(flatManifest.get("flat")?.parent).toBe(moduleParent);
  });

  it("composes intercept target names against the include's name prefix", () => {
    function DetailModal(): null {
      return null;
    }
    const source = clientUrls(({ path, intercept }) => [
      path("/", AccountPage, { name: "index" }),
      path("/detail/:id", AccountPage, { name: "detail" }),
      intercept("@modal", ".detail", DetailModal),
    ]);
    const reference = clientReference("app.urls#prefixed-intercepts");
    const materialized = materializeClientUrlPatterns(
      reference,
      serializeClientUrlPatterns(source),
    );

    const manifest = new Map<string, EntryData>();
    RangoContext.run(
      {
        manifest,
        patterns: new Map(),
        trailingSlash: new Map(),
        searchSchemas: new Map(),
        namespace: "test",
        parent: null,
        counters: {},
      },
      () =>
        runWithPrefixes("/client", "clientGroup", () => materialized.handler()),
    );

    const detail = manifest.get("clientGroup.detail");
    if (!detail) throw new Error("Expected the prefixed detail route");
    const groupLayout = detail.parent;
    const interceptEntry = groupLayout?.intercept[0];
    expect(interceptEntry?.routeName).toBe("clientGroup.detail");

    // The synthesized origin `when` scopes activation to the include's mount:
    // in-group origins activate, outside origins (including prefix-sharing
    // siblings like "/client-extra") fall through to the full route.
    const activates = (pathname: string): boolean =>
      interceptEntry!.when.every((selector) =>
        selector({
          from: { url: new URL(`http://localhost${pathname}`), params: {} },
        } as Parameters<typeof selector>[0]),
      );
    expect(activates("/client")).toBe(true);
    expect(activates("/client/detail/7")).toBe(true);
    expect(activates("/elsewhere")).toBe(false);
    expect(activates("/client-extra")).toBe(false);
    // The browser-side coordination composes the same canonical name:
    // ClientUrlsRoot receives the prefix so beginClientUrlNavigation can
    // decline presentations the intercept will claim.
    const handlerElement = (
      detail.handler as unknown as () => React.ReactElement
    )();
    expect((handlerElement.props as { namePrefix?: string }).namePrefix).toBe(
      "clientGroup",
    );
  });

  it("projects and materializes a data-only transition config onto the route entry", () => {
    const source = clientUrls(({ path, transition, loading }) => [
      path("/detail/:id", AccountPage, { name: "detail" }, () => [
        loading("Detail loading"),
        transition({
          name: "detail-card",
          exit: { navigation: "slide-out" },
          viewTransition: "auto",
        }),
      ]),
    ]);

    const projection = serializeClientUrlPatterns(source);
    expect(projection.routes[0].transition).toEqual({
      name: "detail-card",
      exit: { navigation: "slide-out" },
      viewTransition: "auto",
    });
    expect(JSON.parse(JSON.stringify(projection))).toEqual(projection);

    const manifest = new Map<string, EntryData>();
    RangoContext.run(
      {
        manifest,
        patterns: new Map(),
        trailingSlash: new Map(),
        searchSchemas: new Map(),
        namespace: "test",
        parent: null,
        counters: {},
      },
      () =>
        materializeClientUrlPatterns(
          clientReference("app.urls#transition"),
          projection,
        ).handler(),
    );

    // Materialization re-emits transition(config) in the path use list — the
    // same child position a hand-written server transition() uses — so the
    // route entry carries the config and the segment system applies the hold
    // and (on experimental React) the ViewTransition boundary.
    const detail = manifest.get("detail");
    expect(detail?.transition).toEqual({
      name: "detail-card",
      exit: { navigation: "slide-out" },
      viewTransition: "auto",
    });
  });

  describe("hoisted revalidate() predicates", () => {
    const marker = (key: string) =>
      ({ $$rangoRevalidate: key }) as unknown as ShouldRevalidateFn;

    function materializeRoute(
      reference: Parameters<typeof materializeClientUrlPatterns>[0],
      projection: ClientUrlProjection,
      name: string,
    ): Extract<EntryData, { type: "route" }> {
      const manifest = new Map<string, EntryData>();
      RangoContext.run(
        {
          manifest,
          patterns: new Map(),
          trailingSlash: new Map(),
          searchSchemas: new Map(),
          namespace: "test",
          parent: null,
          counters: {},
        },
        () => materializeClientUrlPatterns(reference, projection).handler(),
      );
      const entry = manifest.get(name);
      if (!entry || entry.type !== "route") throw new Error("Expected route");
      return entry;
    }

    it("projects each loader's hoisted keys and rejects an unhoisted predicate under hoisted serialization", () => {
      const source = clientUrls(({ path, loader, revalidate }) => [
        path("/items/:id", AccountPage, { name: "item" }, () => [
          loader(loaderDefinition("loaders#session"), () => [
            revalidate(marker("k-a")),
            revalidate(marker("k-b")),
          ]),
          loader(loaderDefinition("loaders#item")),
        ]),
      ]);
      expect(
        serializeClientUrlPatterns(source, { hoisted: true }).routes[0]
          .loaderRevalidate,
      ).toEqual([["k-a", "k-b"], []]);

      const plain = clientUrls(({ path, loader, revalidate }) => [
        path("/items/:id", AccountPage, { name: "item" }, () => [
          loader(loaderDefinition("loaders#item")),
          loader(loaderDefinition("loaders#session"), () => [
            revalidate(() => false),
          ]),
        ]),
      ]);
      // Unit tests (no plugin) keep plain functions out of the projection.
      expect(
        serializeClientUrlPatterns(plain).routes[0].loaderRevalidate,
      ).toBeUndefined();
      expect(() =>
        serializeClientUrlPatterns(plain, { hoisted: true }),
      ).toThrow(
        'clientUrls() revalidate() on loader "loaders#session" of route "/items/:id" was not hoisted to the server',
      );
    });

    it("runs a client reference's registered predicate on the server with the urls() arguments", async () => {
      const source = clientUrls(({ path, loader, revalidate }) => [
        path("/items/:id", AccountPage, { name: "item" }, () => [
          loader(loaderDefinition("loaders#cart"), () => [
            revalidate(marker("k-result")),
          ]),
          loader(loaderDefinition("loaders#scoped"), () => [
            revalidate(marker("k-form")),
          ]),
          loader(loaderDefinition("loaders#plain")),
        ]),
      ]);
      const seen: RevalidateParams[] = [];
      registerClientUrlRevalidators({
        "k-result": (args) => {
          seen.push(args);
          return args.actionResult?.ok === true;
        },
        "k-form": ({ formData, context }) =>
          formData?.get("scope") === "all" ||
          (context as unknown as { get(key: string): unknown }).get("flag") ===
            "on",
      });
      const entry = materializeRoute(
        clientReference("app.urls#hoisted"),
        serializeClientUrlPatterns(source, { hoisted: true }),
        "item",
      );
      // A loader without predicates gets the defaults: no revalidate() item.
      expect(entry.loader.map(({ revalidate }) => revalidate.length)).toEqual([
        1, 1, 0,
      ]);

      const [cart, scoped] = entry.loader;
      const action = (result: unknown, formData?: FormData) => ({
        action: { ref: "src/cart.ts#checkout", result, formData },
        currentUrl: "http://localhost/items/1",
      });
      expect(await runRevalidate(cart.revalidate, action({ ok: true }))).toBe(
        true,
      );
      expect(await runRevalidate(cart.revalidate, action({ ok: false }))).toBe(
        false,
      );
      expect(seen[0]).toMatchObject({
        method: "POST",
        actionId: "src/cart.ts#checkout",
        actionResult: { ok: true },
        segmentType: "loader",
        defaultShouldRevalidate: true,
      });
      expect(seen[0].isAction()).toBe(true);

      const all = new FormData();
      all.set("scope", "all");
      expect(
        await runRevalidate(scoped.revalidate, action({ ok: true }, all)),
      ).toBe(true);
      expect(await runRevalidate(scoped.revalidate, action({ ok: true }))).toBe(
        false,
      );
      expect(
        await runRevalidate(scoped.revalidate, { vars: { flag: "on" } }),
      ).toBe(true);
    });

    it("projects an intercept loader's hoisted keys and runs them on the server with the action result", async () => {
      const source = clientUrls(({ path, intercept, loader, revalidate }) => [
        path("/items/:id", AccountPage, { name: "item" }),
        intercept("@modal", ".item", AccountPage, () => [
          loader(loaderDefinition("loaders#modal"), () => [
            revalidate(marker("k-modal")),
          ]),
          loader(loaderDefinition("loaders#plain")),
        ]),
      ]);
      registerClientUrlRevalidators({
        "k-modal": ({ actionResult }) => actionResult?.ok === true,
      });
      const projection = serializeClientUrlPatterns(source, { hoisted: true });
      expect(projection.intercepts![0]!.loaderRevalidate).toEqual([
        ["k-modal"],
        [],
      ]);
      expect(JSON.parse(JSON.stringify(projection))).toEqual(projection);

      const entry = materializeRoute(
        clientReference("app.urls#intercept-hoisted"),
        projection,
        "item",
      );
      const [modal, plain] = entry.parent!.intercept[0]!.loader;
      expect(plain!.revalidate).toEqual([]);
      const action = (result: unknown) => ({
        action: { ref: "src/modal.ts#save", result },
        currentUrl: "http://localhost/items/1",
      });
      expect(await runRevalidate(modal!.revalidate, action({ ok: true }))).toBe(
        true,
      );
      expect(
        await runRevalidate(modal!.revalidate, action({ ok: false })),
      ).toBe(false);

      // An unhoisted predicate on an intercept loader fails as a route's does.
      expect(() =>
        serializeClientUrlPatterns(
          clientUrls(({ path, intercept, loader, revalidate }) => [
            path("/items/:id", AccountPage, { name: "item" }),
            intercept("@modal", ".item", AccountPage, () => [
              loader(loaderDefinition("loaders#modal"), () => [
                revalidate(() => false),
              ]),
            ]),
          ]),
          { hoisted: true },
        ),
      ).toThrow(
        'clientUrls() revalidate() on loader "loaders#modal" of intercept ".item" was not hoisted to the server',
      );
    });

    it("projects an intercept loader's revalidate(true | false) and runs it on the server", async () => {
      const source = clientUrls(({ path, intercept, loader, revalidate }) => [
        path("/items/:id", AccountPage, { name: "item" }),
        intercept("@modal", ".item", AccountPage, () => [
          loader(loaderDefinition("loaders#always"), () => [revalidate(true)]),
          loader(loaderDefinition("loaders#never"), () => [
            revalidate(false),
            revalidate(marker("k-modal-flag")),
          ]),
        ]),
      ]);
      registerClientUrlRevalidators({ "k-modal-flag": true });
      const projection = serializeClientUrlPatterns(source, { hoisted: true });
      expect(projection.intercepts![0]!.loaderRevalidate).toEqual([
        [true],
        [false, "k-modal-flag"],
      ]);
      expect(JSON.parse(JSON.stringify(projection))).toEqual(projection);

      const [always, never] = materializeRoute(
        clientReference("app.urls#intercept-literals"),
        projection,
        "item",
      ).parent!.intercept[0]!.loader;
      const sameUrl = { currentUrl: "http://localhost/items/1" };
      // A same-URL navigation: the default holds, true re-runs.
      expect(await runRevalidate(always!.revalidate, sameUrl)).toBe(true);
      // An action: the default re-runs, false holds and ends the chain
      // before the hoisted true.
      expect(
        await runRevalidate(never!.revalidate, {
          ...sameUrl,
          action: "src/modal.ts#save",
        }),
      ).toBe(false);
    });

    it("fails at materialization when a hoisted key has no server registration", () => {
      const source = clientUrls(({ path, loader, revalidate }) => [
        path("/items/:id", AccountPage, { name: "item" }, () => [
          loader(loaderDefinition("loaders#cart"), () => [
            revalidate(marker("k-missing")),
          ]),
        ]),
      ]);
      expect(() =>
        materializeRoute(
          clientReference("/src/shop.client.tsx#default"),
          serializeClientUrlPatterns(source, { hoisted: true }),
          "item",
        ),
      ).toThrow(
        'clientUrls() revalidate() on loader "loaders#cart" of route "/items/:id" in "/src/shop.client.tsx#default" has no server registration (key "k-missing")',
      );
    });

    it("projects a revalidate(true | false) literal as itself and materializes it as the constant predicate", async () => {
      const source = clientUrls(({ path, loader, revalidate }) => [
        path("/items/:id", AccountPage, { name: "item" }, () => [
          loader(loaderDefinition("loaders#always"), () => [revalidate(true)]),
          loader(loaderDefinition("loaders#never"), () => [
            revalidate(false),
            revalidate(marker("k-after-false")),
          ]),
          loader(loaderDefinition("loaders#plain")),
        ]),
      ]);
      const projection = serializeClientUrlPatterns(source, { hoisted: true });
      expect(projection.routes[0].loaderRevalidate).toEqual([
        [true],
        [false, "k-after-false"],
        [],
      ]);
      // The serialized projection is what discovery hands the server.
      expect(JSON.parse(JSON.stringify(projection))).toEqual(projection);

      let afterFalseCalls = 0;
      registerClientUrlRevalidators({
        "k-after-false": () => {
          afterFalseCalls++;
          return true;
        },
      });
      const [always, never, plain] = materializeRoute(
        clientReference("app.urls#literals"),
        projection,
        "item",
      ).loader;
      const sameUrl = { currentUrl: "http://localhost/items/1" };
      const action = { ...sameUrl, action: "src/cart.ts#checkout" };
      // A same-URL navigation: the default holds, true re-runs.
      expect(await runRevalidate(plain.revalidate, sameUrl)).toBe(false);
      expect(await runRevalidate(always.revalidate, sameUrl)).toBe(true);
      // An action: the default re-runs, false holds and ends the chain.
      expect(await runRevalidate(plain.revalidate, action)).toBe(true);
      expect(await runRevalidate(never.revalidate, action)).toBe(false);
      expect(afterFalseCalls).toBe(0);
    });

    it("runs a hoisted expression the server evaluated to a boolean, and rejects any other value at materialization", async () => {
      const source = clientUrls(({ path, loader, revalidate }) => [
        path("/items/:id", AccountPage, { name: "item" }, () => [
          loader(loaderDefinition("loaders#flag"), () => [
            revalidate(marker("k-flag")),
          ]),
        ]),
      ]);
      const projection = serializeClientUrlPatterns(source, { hoisted: true });
      registerClientUrlRevalidators({ "k-flag": false });
      const [flag] = materializeRoute(
        clientReference("app.urls#flag"),
        projection,
        "item",
      ).loader;
      expect(
        await runRevalidate(flag.revalidate, { action: "src/cart.ts#x" }),
      ).toBe(false);
      // Looked up per call: a dev re-evaluation that flips the flag applies.
      registerClientUrlRevalidators({ "k-flag": true });
      expect(await runRevalidate(flag.revalidate)).toBe(true);

      registerClientUrlRevalidators({ "k-flag": "yes" as never });
      expect(() =>
        materializeRoute(clientReference("app.urls#flag"), projection, "item"),
      ).toThrow(
        'clientUrls() revalidate() on loader "loaders#flag" of route "/items/:id" in "app.urls#flag" has no server registration (key "k-flag")',
      );
    });

    it("attaches a definition object's own revalidate(true | false)", async () => {
      const source = clientUrls(({ path, loader, revalidate }) => [
        path("/items/:id", AccountPage, { name: "item" }, () => [
          loader(loaderDefinition("loaders#always"), () => [revalidate(true)]),
          loader(loaderDefinition("loaders#never"), () => [revalidate(false)]),
        ]),
      ]);
      const [always, never] = materializeRoute(
        source,
        serializeClientUrlPatterns(source),
        "item",
      ).loader;
      expect(await runRevalidate(always.revalidate)).toBe(true);
      expect(
        await runRevalidate(never.revalidate, { action: "src/cart.ts#x" }),
      ).toBe(false);
    });

    it("attaches a definition object's own predicates", async () => {
      const source = clientUrls(({ path, loader, revalidate }) => [
        path("/items/:id", AccountPage, { name: "item" }, () => [
          loader(loaderDefinition("loaders#item"), () => [
            revalidate(({ currentParams, nextParams }) =>
              currentParams.id === nextParams.id ? false : undefined,
            ),
          ]),
        ]),
      ]);
      const entry = materializeRoute(
        source,
        serializeClientUrlPatterns(source),
        "item",
      );
      const [item] = entry.loader;
      expect(
        await runRevalidate(item.revalidate, {
          currentParams: { id: "1" },
          nextParams: { id: "2" },
        }),
      ).toBe(true);
      expect(
        await runRevalidate(item.revalidate, {
          currentParams: { id: "1" },
          currentUrl: "http://localhost/items/1",
          nextUrl: "http://localhost/items/1?tab=a",
        }),
      ).toBe(false);
    });
  });

  it("delegates projected loader execution by $$id with the original context", async () => {
    const context = {
      params: { id: "42" },
    } as unknown as LoaderContext;
    const loaderFn = vi.fn(async (receivedContext: LoaderContext) => ({
      id: receivedContext.params.id,
    }));
    getLoaderLazyMock.mockResolvedValue({
      fn: loaderFn,
      middleware: [],
      fetchable: false,
    });
    const projectedLoader = materializedLoaderDefinition("loaders#dynamic");

    if (!projectedLoader.fn) {
      throw new Error("Expected the projected loader to be executable");
    }
    await expect(projectedLoader.fn(context)).resolves.toEqual({ id: "42" });

    expect(getLoaderLazyMock).toHaveBeenCalledOnce();
    expect(getLoaderLazyMock).toHaveBeenCalledWith("loaders#dynamic");
    expect(loaderFn).toHaveBeenCalledOnce();
    expect(loaderFn).toHaveBeenCalledWith(context);
  });

  it("fails clearly when a projected loader id is not registered", async () => {
    getLoaderLazyMock.mockResolvedValue(undefined);
    const projectedLoader = materializedLoaderDefinition("loaders#unknown");

    if (!projectedLoader.fn) {
      throw new Error("Expected the projected loader to be executable");
    }
    await expect(
      projectedLoader.fn({ params: {} } as unknown as LoaderContext),
    ).rejects.toThrow(
      'Projected loader "loaders#unknown" was not found in the server loader registry',
    );
  });

  it("normalizes direct .routes(clientUrls) to a root include with bare names", async () => {
    const patterns = clientUrls(({ path }) => [
      path("/", AccountPage, { name: "index" }),
      path("/accounts/:id", AccountPage, { name: "account" }),
    ]);

    // Pure-client shorthand: sugar over include("/", definition, { name: "" })
    // in the ONE composition model — no separate registration path.
    const router = toInternal(
      createRouter({ id: "client-urls-sugar" }).routes(patterns),
    );
    const manifest = await generateManifestFull(router.urlpatterns!);
    expect(manifest.routeManifest["index"]).toBe("/");
    expect(manifest.routeManifest["account"]).toBe("/accounts/:id");

    // Under a basename the SAME normalization inherits the registration
    // urlPrefix, exactly like discovery/manifest-init pass router.basename.
    // The contract is PARITY with hand-writing the root include over a server
    // module — whatever join/normalization include() applies, the sugar gets.
    const basenameRouter = toInternal(
      createRouter({
        id: "client-urls-sugar-basename",
        basename: "/app",
      }).routes(patterns),
    );
    const prefixed = await generateManifestFull(
      basenameRouter.urlpatterns!,
      undefined,
      { urlPrefix: "/app" },
    );
    const serverEquivalent = urls(({ include }) => [
      include(
        "/",
        urls(({ path }) => [
          path("/", AccountPage, { name: "index" }),
          path("/accounts/:id", AccountPage, { name: "account" }),
        ]),
        { name: "" },
      ),
    ]);
    const serverPrefixed = await generateManifestFull(
      serverEquivalent,
      undefined,
      { urlPrefix: "/app" },
    );
    expect(prefixed.routeManifest).toEqual(serverPrefixed.routeManifest);
    expect(prefixed.routeManifest["account"]).toBe("/app/accounts/:id");

    // A client REFERENCE goes through the same lazy include: no projection ->
    // clear error at evaluation; installed projection -> materializes.
    const reference = clientReference("app.urls#sugar-ref");
    const refRouter = toInternal(
      createRouter({ id: "client-urls-sugar-ref" }).routes(
        reference as unknown as typeof patterns,
      ),
    );
    await expect(generateManifestFull(refRouter.urlpatterns!)).rejects.toThrow(
      /could not resolve the server projection/,
    );
    setClientUrlProjection(reference, serializeClientUrlPatterns(patterns));
    const refManifest = await generateManifestFull(refRouter.urlpatterns!);
    expect(refManifest.routeManifest["account"]).toBe("/accounts/:id");
  });

  it("mounts through include() with URL and route-name prefixes from the server tree", async () => {
    const definition = clientUrls(({ path, loader }) => [
      path("/", AccountPage, { name: "index" }),
      path("/:accountId", AccountPage, { name: "detail" }, () => [
        loader(loaderDefinition("loaders#account")),
      ]),
    ]);

    const serverTree = urls(({ include }) => [
      include("/account", definition, { name: "account" }),
    ]);

    // Discovery (generateManifestFull) is what powers reverse()/types/trie —
    // the include supplies both prefixes; the bare mount is the module index.
    const manifest = await generateManifestFull(serverTree);
    expect(manifest.routeManifest["account.index"]).toBe("/account");
    expect(manifest.routeManifest["account.detail"]).toBe(
      "/account/:accountId",
    );
  });

  // MECHANICS-LEVEL ONLY: the manifest composes correctly through an async
  // include (projection lookup is import-timing independent), but the full
  // pipeline is NOT supported — runtime lazy expansion of a nested substituted
  // include does not reproduce discovery's auto-name identity and requests
  // 404 (documented limit in docs/client-urls.md). This test pins the
  // manifest half so lifting the limit only needs the runtime half.
  it("composes manifest prefixes for a clientUrls include nested in an async include()", async () => {
    const source = clientUrls(({ path, loader }) => [
      path("/", AccountPage, { name: "index" }),
      path("/:accountId", AccountPage, { name: "detail" }, () => [
        loader(loaderDefinition("loaders#account")),
      ]),
    ]);
    const reference = clientReference("app.urls#async-nested");
    setClientUrlProjection(reference, serializeClientUrlPatterns(source));

    // The async include module is only evaluated when discovery resolves the
    // provider — the projection must already be installed by then (the
    // filesystem scan makes recording independent of import-graph timing).
    const asyncModule = urls(({ include }) => [
      include("/nested", reference as unknown as typeof source, {
        name: "client",
      }),
    ]);
    const outerTree = urls(({ include }) => [
      include("/lazy", async () => ({ default: asyncModule }), {
        name: "lazy",
      }),
    ]);

    const manifest = await generateManifestFull(outerTree);
    expect(manifest.routeManifest["lazy.client.index"]).toBe("/lazy/nested");
    expect(manifest.routeManifest["lazy.client.detail"]).toBe(
      "/lazy/nested/:accountId",
    );
  });

  it("materializes a client-reference include lazily from the installed projection", async () => {
    const source = clientUrls(({ path, loader, loading }) => [
      path("/", AccountPage, { name: "index" }),
      path("/:accountId", AccountPage, { name: "detail" }, () => [
        loader(loaderDefinition("loaders#account")),
        loading("Loading account"),
      ]),
    ]);
    const reference = clientReference("app.urls#include-ref");

    const serverTree = urls(({ include }) => [
      include("/account", reference as unknown as typeof source, {
        name: "account",
      }),
    ]);

    // No projection yet: definition/registration stays lazy; the clear error
    // surfaces only when the include is evaluated.
    await expect(generateManifestFull(serverTree)).rejects.toThrow(
      /could not resolve the server projection/,
    );

    // Installing the projection makes the SAME lazy include materialize.
    setClientUrlProjection(reference, serializeClientUrlPatterns(source));
    const manifest = await generateManifestFull(serverTree);
    expect(manifest.routeManifest["account.index"]).toBe("/account");
    expect(manifest.routeManifest["account.detail"]).toBe(
      "/account/:accountId",
    );
  });

  it("resolves an async include() whose module default is the clientUrls() client reference", async () => {
    const source = clientUrls(({ path, loader }) => [
      path("/", AccountPage, { name: "index" }),
      path("/:accountId", AccountPage, { name: "detail" }, () => [
        loader(loaderDefinition("loaders#account")),
      ]),
    ]);
    const reference = clientReference("portal.client#default");
    setClientUrlProjection(reference, serializeClientUrlPatterns(source));

    // `() => import("./portal.client")` on the server: a module namespace whose
    // `default` is the client reference — no urls() wrapper module between the
    // include and the group. resolveIncludeModule must adapt the reference
    // BEFORE duck-typing `.handler` (a real reference Proxy throws on that read).
    const serverTree = urls(({ include }) => [
      include(
        "/portal",
        async () => ({ default: reference as unknown as typeof source }),
        { name: "portal" },
      ),
    ]);

    const manifest = await generateManifestFull(serverTree);
    expect(manifest.routeManifest["portal.index"]).toBe("/portal");
    expect(manifest.routeManifest["portal.detail"]).toBe("/portal/:accountId");
  });
});
