/**
 * Tests that createMatchContextForPartial wires the intercept selector
 * context correctly when X-RSC-Router-Intercept-Source is present.
 *
 * When an HMR refetch (or action revalidation) fires while an intercept
 * modal is open, the browser sends the original source URL via this header.
 * The server must use it as `from` in the selector context so `when()` guards
 * evaluate against the original navigation source, not the current page URL.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock heavy dependencies that createMatchContextForPartial pulls in.
// Several transitive imports reference virtual: modules that don't exist
// outside of Vite, so we mock the entire import tree.
vi.mock("../manifest.js", () => ({
  loadManifest: vi.fn(async () => ({
    type: "route",
    shortCode: "R0",
    routeKey: "product.detail",
    parent: null,
    cache: null,
  })),
  clearManifestCache: vi.fn(),
}));

vi.mock("../middleware.js", () => ({
  collectRouteMiddleware: vi.fn(() => []),
}));

vi.mock("../handler-context.js", () => ({
  createHandlerContext: vi.fn(() => ({})),
  stripInternalParams: vi.fn((url: URL) => url),
}));

vi.mock("../loader-resolution.js", () => ({
  setupLoaderAccess: vi.fn(),
}));

vi.mock("../pattern-matching.js", () => ({
  traverseBack: vi.fn(() => []),
}));

vi.mock("../../server/context", () => ({
  getContext: vi.fn(() => ({
    getOrCreateStore: vi.fn(() => ({
      run: (fn: any) => fn(),
      namespace: null,
      parent: null,
    })),
    runWithStore: vi.fn((_s: any, _ns: any, _p: any, fn: any) => fn()),
  })),
  EntryData: {},
  LoaderEntry: {},
  InterceptSelectorContext: {},
}));

vi.mock("../../server/request-context.js", () => ({
  getRequestContext: vi.fn(),
  setRequestContextPrevRouteKey: vi.fn(),
}));

vi.mock("../logging.js", () => ({
  debugLog: vi.fn(),
  debugWarn: vi.fn(),
}));

vi.mock("../../cache/cache-scope.js", () => ({
  CacheScope: vi.fn(),
  createCacheScope: vi.fn(() => null),
}));

vi.mock("../error-handling.js", () => ({
  createErrorInfo: vi.fn(),
  createErrorSegment: vi.fn(),
  findNearestErrorBoundary: vi.fn(() => null),
}));

vi.mock("../../default-error-boundary.js", () => ({
  DefaultErrorFallback: vi.fn(),
}));

vi.mock("../../errors", () => ({
  RouteNotFoundError: class extends Error {},
  invariant: vi.fn(),
}));

import { createMatchContextForPartial } from "../match-api.js";
import type { MatchApiDeps } from "../types.js";

function routeKeyForPath(pathname: string): string {
  if (pathname === "/") return "index";
  if (pathname.startsWith("/product")) return "product.detail";
  if (pathname.startsWith("/shop")) return "shop.items";
  if (pathname.startsWith("/health")) return "$path__health";
  return "unknown";
}

function makeDeps(overrides?: Partial<MatchApiDeps<unknown>>): MatchApiDeps {
  return {
    findMatch: vi.fn((pathname: string) => ({
      params: {},
      route: routeKeyForPath(pathname),
      routeKey: routeKeyForPath(pathname),
      entry: {},
    })),
    getMetricsStore: vi.fn(() => undefined),
    findInterceptForRoute: vi.fn(() => null),
    callOnError: vi.fn(),
    findNearestErrorBoundary: vi.fn(() => null),
    getRouteMap: vi.fn(() => ({})),
    ...overrides,
  };
}

describe("createMatchContextForPartial intercept source", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses interceptSourceUrl for selector context from and segments.path", async () => {
    const findInterceptSpy = vi.fn(() => null);
    const deps = makeDeps();

    // Simulate HMR refetch while on /product/product-a with intercept from /
    const request = new Request(
      "http://localhost:5173/product/product-a?_rsc_segments=",
      {
        headers: {
          "X-RSC-Router-Client-Path": "http://localhost:5173/product/product-a",
          "X-RSC-Router-Intercept-Source": "http://localhost:5173/",
          "X-RSC-HMR": "1",
        },
      },
    );

    const result = await createMatchContextForPartial(
      request,
      {},
      deps,
      findInterceptSpy,
    );

    expect(result).not.toBeNull();
    const ctx = result!;

    // The selector context's "from" should be the intercept source (/)
    // not the current URL (/product/product-a)
    expect(ctx.interceptSelectorContext.from.pathname).toBe("/");
    expect(ctx.interceptSelectorContext.segments.path).toEqual([]);
  });

  it("uses prevUrl for selector context when no intercept source", async () => {
    const findInterceptSpy = vi.fn(() => null);
    const deps = makeDeps();

    // Normal navigation from /shop to /product/product-a
    const request = new Request(
      "http://localhost:5173/product/product-a?_rsc_segments=",
      {
        headers: {
          "X-RSC-Router-Client-Path": "http://localhost:5173/shop",
        },
      },
    );

    const result = await createMatchContextForPartial(
      request,
      {},
      deps,
      findInterceptSpy,
    );

    expect(result).not.toBeNull();
    const ctx = result!;

    // Without intercept source, "from" should be the previous URL (/shop)
    expect(ctx.interceptSelectorContext.from.pathname).toBe("/shop");
    expect(ctx.interceptSelectorContext.segments.path).toEqual(["shop"]);
  });

  it("passes correct selector context to findInterceptForRoute", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const findInterceptSpy = vi.fn((..._args: any[]) => null);
    const deps = makeDeps();

    const request = new Request(
      "http://localhost:5173/product/product-a?_rsc_segments=",
      {
        headers: {
          "X-RSC-Router-Client-Path": "http://localhost:5173/product/product-a",
          "X-RSC-Router-Intercept-Source": "http://localhost:5173/shop/items",
        },
      },
    );

    await createMatchContextForPartial(request, {}, deps, findInterceptSpy);

    // findInterceptForRoute should receive the selector context with
    // from derived from the intercept source URL
    expect(findInterceptSpy).toHaveBeenCalled();
    const selectorCtx = findInterceptSpy.mock.calls[0][2];
    expect(selectorCtx.from.pathname).toBe("/shop/items");
    expect(selectorCtx.segments.path).toEqual(["shop", "items"]);
  });
});

describe("createMatchContextForPartial when() route names", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sets fromRouteName and toRouteName for named routes", async () => {
    const findInterceptSpy = vi.fn(() => null);
    const deps = makeDeps();

    // Navigate from /shop to /product/product-a (both named routes)
    const request = new Request(
      "http://localhost:5173/product/product-a?_rsc_segments=",
      {
        headers: {
          "X-RSC-Router-Client-Path": "http://localhost:5173/shop",
        },
      },
    );

    const result = await createMatchContextForPartial(
      request,
      {},
      deps,
      findInterceptSpy,
    );

    expect(result).not.toBeNull();
    const ctx = result!;
    expect(ctx.interceptSelectorContext.toRouteName).toBe("product.detail");
    expect(ctx.interceptSelectorContext.fromRouteName).toBe("shop.items");
  });

  it("sets fromRouteName to undefined for auto-generated source route", async () => {
    const findInterceptSpy = vi.fn(() => null);
    const deps = makeDeps();

    // Navigate from /health ($path__health) to /product/product-a
    const request = new Request(
      "http://localhost:5173/product/product-a?_rsc_segments=",
      {
        headers: {
          "X-RSC-Router-Client-Path": "http://localhost:5173/health",
        },
      },
    );

    const result = await createMatchContextForPartial(
      request,
      {},
      deps,
      findInterceptSpy,
    );

    expect(result).not.toBeNull();
    const ctx = result!;
    expect(ctx.interceptSelectorContext.toRouteName).toBe("product.detail");
    expect(ctx.interceptSelectorContext.fromRouteName).toBeUndefined();
  });

  it("sets toRouteName to undefined for auto-generated target route", async () => {
    const findInterceptSpy = vi.fn(() => null);
    const deps = makeDeps();

    // Navigate from /shop (named) to /health (auto-generated)
    const request = new Request("http://localhost:5173/health?_rsc_segments=", {
      headers: {
        "X-RSC-Router-Client-Path": "http://localhost:5173/shop",
      },
    });

    const result = await createMatchContextForPartial(
      request,
      {},
      deps,
      findInterceptSpy,
    );

    expect(result).not.toBeNull();
    const ctx = result!;
    expect(ctx.interceptSelectorContext.toRouteName).toBeUndefined();
    expect(ctx.interceptSelectorContext.fromRouteName).toBe("shop.items");
  });

  it("uses intercept source for fromRouteName when header is present", async () => {
    const findInterceptSpy = vi.fn(() => null);
    const deps = makeDeps();

    // HMR refetch: on /product/product-a, intercept source from /shop/items
    const request = new Request(
      "http://localhost:5173/product/product-a?_rsc_segments=",
      {
        headers: {
          "X-RSC-Router-Client-Path": "http://localhost:5173/product/product-a",
          "X-RSC-Router-Intercept-Source": "http://localhost:5173/shop/items",
        },
      },
    );

    const result = await createMatchContextForPartial(
      request,
      {},
      deps,
      findInterceptSpy,
    );

    expect(result).not.toBeNull();
    const ctx = result!;
    // fromRouteName should be derived from the intercept source (/shop/items),
    // consistent with from.pathname which also uses the intercept source
    expect(ctx.interceptSelectorContext.toRouteName).toBe("product.detail");
    expect(ctx.interceptSelectorContext.fromRouteName).toBe("shop.items");
  });
});
