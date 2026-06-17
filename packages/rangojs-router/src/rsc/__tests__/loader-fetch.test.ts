import { describe, it, expect, vi, beforeEach } from "vitest";

// Capture the loader context passed to the loader function
let capturedCtx: any = null;

vi.mock("../../server/loader-registry.js", () => ({
  getLoaderLazy: vi.fn(async () => ({
    fn: async (ctx: any) => {
      capturedCtx = ctx;
      return { greeting: "hello" };
    },
    middleware: [],
    fetchable: true,
  })),
}));

vi.mock("../../server/request-context.js", () => {
  const make = () => ({
    env: {},
    request: new Request("http://localhost/"),
    url: new URL("http://localhost/"),
    pathname: "/",
    searchParams: new URLSearchParams(),
    var: {},
    get: () => undefined,
    set: () => {},
    params: {},
    _routeName: "products",
    _onResponseCallbacks: [],
    res: { headers: new Headers(), status: 200 },
  });
  return {
    requireRequestContext: make,
    // observePhase (loader instrumentation) reads store + tracing from here;
    // the mock context has neither, so it is a pass-through and the loader runs.
    _getRequestContext: make,
  };
});

vi.mock("../../router/middleware.js", () => ({
  executeLoaderMiddleware: vi.fn(
    async (
      _mw: any[],
      _req: any,
      _env: any,
      _params: any,
      _vars: any,
      handler: () => Promise<Response>,
    ) => handler(),
  ),
}));

vi.mock("../../route-map-builder.js", () => ({
  getGlobalRouteMap: () => ({}),
  getSearchSchema: (routeName: string) => {
    if (routeName === "products") {
      return { tab: "string", page: "number?" };
    }
    return undefined;
  },
  isRouteRootScoped: () => undefined,
}));

vi.mock("../../router/handler-context.js", async (importOriginal) => {
  const original = (await importOriginal()) as any;
  return {
    ...original,
    createReverseFunction: () => () => "/",
  };
});

vi.mock("../helpers.js", () => ({
  createResponseWithMergedHeaders: (body: any, init: any) =>
    new Response(body, init),
  finalizeResponse: (r: Response) => r,
}));

import { handleLoaderFetch } from "../loader-fetch";

function createMockHandlerCtx() {
  return {
    renderToReadableStream: () => new ReadableStream(),
    callOnError: vi.fn(),
    getRequiredRouteMap: () => ({}),
  } as any;
}

describe("handleLoaderFetch context parity", () => {
  beforeEach(() => {
    capturedCtx = null;
  });

  it("strips _rsc_loader* params and preserves user query on loaderCtx", async () => {
    const url = new URL(
      "http://localhost/products?tab=pricing&page=2&_rsc_loader=myLoader&_rsc_loader_params=%7B%7D",
    );
    const request = new Request(url.href, {
      headers: { Accept: "text/x-component" },
    });

    await handleLoaderFetch(createMockHandlerCtx(), request, {}, url, {});

    expect(capturedCtx).not.toBeNull();
    // User params preserved
    expect(capturedCtx.searchParams.get("tab")).toBe("pricing");
    expect(capturedCtx.searchParams.get("page")).toBe("2");
    // Internal params stripped
    expect(capturedCtx.searchParams.has("_rsc_loader")).toBe(false);
    expect(capturedCtx.searchParams.has("_rsc_loader_params")).toBe(false);
    // URL is cleaned too
    expect(capturedCtx.url.searchParams.has("_rsc_loader")).toBe(false);
    expect(capturedCtx.url.searchParams.get("tab")).toBe("pricing");
    expect(capturedCtx.pathname).toBe("/products");
  });

  it("populates ctx.search from route search schema", async () => {
    const url = new URL(
      "http://localhost/products?tab=pricing&page=3&_rsc_loader=myLoader",
    );
    const request = new Request(url.href, {
      headers: { Accept: "text/x-component" },
    });

    await handleLoaderFetch(createMockHandlerCtx(), request, {}, url, {});

    expect(capturedCtx).not.toBeNull();
    // search is parsed from schema: tab is string, page is number
    expect(capturedCtx.search.tab).toBe("pricing");
    expect(capturedCtx.search.page).toBe(3);
  });

  it("returns empty search when route has no search schema", async () => {
    // Override _routeName to a route without a search schema
    const { requireRequestContext } =
      await import("../../server/request-context.js");
    const original = (requireRequestContext as any)();
    vi.mocked(
      await import("../../server/request-context.js"),
    ).requireRequestContext = (() => ({
      ...original,
      _routeName: "unknown-route",
    })) as any;

    const url = new URL(
      "http://localhost/other?tab=pricing&_rsc_loader=myLoader",
    );
    const request = new Request(url.href, {
      headers: { Accept: "text/x-component" },
    });

    await handleLoaderFetch(createMockHandlerCtx(), request, {}, url, {});

    expect(capturedCtx).not.toBeNull();
    expect(capturedCtx.search).toEqual({});
    // searchParams still has the user param
    expect(capturedCtx.searchParams.get("tab")).toBe("pricing");
  });
});
