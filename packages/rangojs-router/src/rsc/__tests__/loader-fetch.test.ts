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
    getRequestContext: make,
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
    const { getRequestContext } =
      await import("../../server/request-context.js");
    const original = (getRequestContext as any)();
    vi.mocked(
      await import("../../server/request-context.js"),
    ).getRequestContext = (() => ({
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

// The request's loader params become ctx.params, so they hold only what a
// route param can: string keys and string values, never a reserved key
// (#1109).
describe("handleLoaderFetch loader params", () => {
  beforeEach(() => {
    capturedCtx = null;
  });

  const get = (params: string) => {
    const url = new URL("http://localhost/products?_rsc_loader=myLoader");
    url.searchParams.set("_rsc_loader_params", params);
    return handleLoaderFetch(
      createMockHandlerCtx(),
      new Request(url.href, { headers: { Accept: "text/x-component" } }),
      {},
      url,
      {},
    );
  };
  const post = (body: BodyInit, contentType?: string) => {
    const url = new URL("http://localhost/products?_rsc_loader=myLoader");
    const headers: Record<string, string> = { Accept: "text/x-component" };
    if (contentType) headers["Content-Type"] = contentType;
    return handleLoaderFetch(
      createMockHandlerCtx(),
      new Request(url.href, { method: "POST", headers, body }),
      {},
      url,
      {},
    );
  };

  it.each([
    ['{"id":"1"}', { id: "1" }],
    ['{"id":"","q":"a b"}', { id: "", q: "a b" }],
    ["{}", {}],
  ])("a GET with %s reaches the loader", async (params, expected) => {
    const res = await get(params);
    expect(res.status).toBe(200);
    expect(capturedCtx.params).toEqual(expected);
  });

  it.each([
    ['{"id":1}'],
    ['{"id":null}'],
    ['{"id":{"a":"b"}}'],
    ['{"id":["a"]}'],
    ['{"__proto__":"x"}'],
    ['{"__proto__":{"id":"x"}}'],
    ['{"constructor":"x"}'],
    ['{"prototype":"x"}'],
    ['["a"]'],
    ['"a"'],
    ["1"],
    ["null"],
  ])("a GET with %s is a 400 and never runs the loader", async (params) => {
    const res = await get(params);
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/^Invalid loader params/);
    expect(capturedCtx).toBeNull();
  });

  it("a JSON POST checks params the same way", async () => {
    const ok = await post(
      JSON.stringify({ params: { id: "1" }, body: { n: 1 } }),
      "application/json",
    );
    expect(ok.status).toBe(200);
    expect(capturedCtx.params).toEqual({ id: "1" });
    expect(capturedCtx.body).toEqual({ n: 1 });

    capturedCtx = null;
    for (const params of [{ id: 1 }, { constructor: "x" }, "x", ["a"]]) {
      const res = await post(JSON.stringify({ params }), "application/json");
      expect(res.status).toBe(400);
      expect(capturedCtx).toBeNull();
    }
  });

  it("a multipart POST checks params the same way", async () => {
    const form = (params: string) => {
      const fd = new FormData();
      fd.set("_rsc_loader_params", params);
      fd.set("file", "content");
      return fd;
    };
    const ok = await post(form('{"id":"1"}'));
    expect(ok.status).toBe(200);
    expect(capturedCtx.params).toEqual({ id: "1" });

    capturedCtx = null;
    const bad = await post(form('{"__proto__":"x"}'));
    expect(bad.status).toBe(400);
    expect(capturedCtx).toBeNull();
  });
});
