import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildRouteTrie } from "../../build/route-trie.js";
import { tryTrieMatch } from "../../router/trie-matching.js";
import { RangoContext, type EntryData } from "../../server/context.js";
import type { LoaderContext, LoaderDefinition } from "../../types.js";
import type { PathOptions } from "../../urls/pattern-types.js";
import { createRouter } from "../../router.js";
import { urls } from "../../urls/urls-function.js";
import { generateManifestFull } from "../../build/generate-manifest.js";
import { ClientUrlsLoading, ClientUrlsRoot } from "../client-root.js";
import { clientUrls } from "../client-urls.js";
import {
  clearClientUrlProjections,
  getClientUrlProjection,
  isClientUrlReference,
  isClientUrlPatterns,
  materializeClientUrlPatterns,
  serializeClientUrlPatterns,
  setClientUrlProjection,
  type ClientUrlReference,
} from "../server-projection.js";

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

  it("rejects ppr, unsupported options, and missing loader ids", () => {
    const pprOptions = { ppr: true } as unknown as PathOptions;
    expect(() =>
      serializeClientUrlPatterns(
        clientUrls(({ path }) => [path("/ppr", AccountPage, pprOptions)]),
      ),
    ).toThrow(/path option "ppr" is not supported/);

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

  it("rejects router-level clientUrls() registration — include() is the mounting model", () => {
    const patterns = clientUrls(({ path }) => [
      path("/accounts/:id", AccountPage, { name: "account" }),
    ]);
    const reference = clientReference("app.urls#rejected");

    expect(() =>
      (
        createRouter({ id: "client-urls-reject-direct" }).routes as (
          p: unknown,
        ) => unknown
      )(patterns),
    ).toThrow(/Mount them inside the canonical urls\(\) tree with include\(\)/);
    expect(() =>
      (
        createRouter({ id: "client-urls-reject-ref" }).routes as (
          p: unknown,
        ) => unknown
      )(reference),
    ).toThrow(/Mount them inside the canonical urls\(\) tree with include\(\)/);
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
});
