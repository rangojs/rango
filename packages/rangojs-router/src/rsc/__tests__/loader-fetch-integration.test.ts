/**
 * Integration test for handleLoaderFetch + real executeLoaderMiddleware.
 *
 * Unlike loader-fetch.test.ts, this file does NOT mock executeLoaderMiddleware.
 * It proves handleLoaderFetch wires real middleware execution before the loader
 * function. Registry lookup (getLoaderLazy) is still mocked.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { MiddlewareFn } from "../../router/middleware.js";

// Track middleware and loader execution
let executionOrder: string[] = [];
let capturedCtx: any = null;

const testLoaderFn = async (ctx: any) => {
  executionOrder.push("loader");
  capturedCtx = ctx;
  return { data: "from-loader" };
};

const testMiddleware: MiddlewareFn[] = [
  async (ctx, next) => {
    executionOrder.push("mw1-before");
    ctx.set("mw1", "ran");
    const res = await next();
    executionOrder.push("mw1-after");
    return res;
  },
  async (ctx, next) => {
    executionOrder.push("mw2-before");
    const res = await next();
    executionOrder.push("mw2-after");
    return res;
  },
];

// Mock loader-registry to return test loader with real middleware
vi.mock("../../server/loader-registry.js", () => ({
  getLoaderLazy: vi.fn(),
}));

// Mock request-context to provide a minimal context
vi.mock("../../server/request-context.js", () => ({
  requireRequestContext: () => ({
    env: {},
    request: new Request("http://localhost/"),
    url: new URL("http://localhost/"),
    pathname: "/",
    searchParams: new URLSearchParams(),
    var: {},
    get: () => undefined,
    set: () => {},
    params: {},
    _routeName: "test-route",
    _onResponseCallbacks: [],
    res: { headers: new Headers(), status: 200 },
  }),
  _getRequestContext: () => null,
}));

// DO NOT mock ../../router/middleware.js — that is the point of this test.

vi.mock("../../route-map-builder.js", () => ({
  getGlobalRouteMap: () => ({}),
  getSearchSchema: () => undefined,
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
import { getLoaderLazy } from "../../server/loader-registry";

function createMockHandlerCtx() {
  return {
    renderToReadableStream: () => new ReadableStream(),
    callOnError: vi.fn(),
    getRequiredRouteMap: () => ({}),
  } as any;
}

describe("handleLoaderFetch middleware integration", () => {
  beforeEach(() => {
    executionOrder = [];
    capturedCtx = null;
  });

  it("executes real middleware chain before loader function", async () => {
    vi.mocked(getLoaderLazy).mockResolvedValue({
      fn: testLoaderFn,
      middleware: testMiddleware,
      fetchable: true,
    });

    const url = new URL("http://localhost/test?_rsc_loader=testLoader");
    const request = new Request(url.href, {
      headers: { Accept: "text/x-component" },
    });

    const response = await handleLoaderFetch(
      createMockHandlerCtx(),
      request,
      {},
      url,
      {},
    );

    expect(response.status).toBe(200);
    expect(executionOrder).toEqual([
      "mw1-before",
      "mw2-before",
      "loader",
      "mw2-after",
      "mw1-after",
    ]);
  });

  it("middleware can short-circuit before loader runs", async () => {
    const guardMiddleware: MiddlewareFn = async (_ctx, _next) => {
      executionOrder.push("guard-reject");
      return new Response("Forbidden", { status: 403 });
    };

    vi.mocked(getLoaderLazy).mockResolvedValue({
      fn: testLoaderFn,
      middleware: [guardMiddleware],
      fetchable: true,
    });

    const url = new URL("http://localhost/test?_rsc_loader=protectedLoader");
    const request = new Request(url.href, {
      headers: { Accept: "text/x-component" },
    });

    const response = await handleLoaderFetch(
      createMockHandlerCtx(),
      request,
      {},
      url,
      {},
    );

    expect(response.status).toBe(403);
    expect(await response.text()).toBe("Forbidden");
    // Loader never ran
    expect(executionOrder).toEqual(["guard-reject"]);
    expect(capturedCtx).toBeNull();
  });

  it("middleware variables propagate through the chain", async () => {
    const variables: Record<string, any> = {};
    let capturedMw2Var: any;

    const mw1: MiddlewareFn = async (ctx, next) => {
      ctx.set("userId", "user-42");
      return next();
    };

    const mw2: MiddlewareFn = async (ctx, next) => {
      capturedMw2Var = ctx.get("userId");
      return next();
    };

    vi.mocked(getLoaderLazy).mockResolvedValue({
      fn: testLoaderFn,
      middleware: [mw1, mw2],
      fetchable: true,
    });

    const url = new URL("http://localhost/test?_rsc_loader=varLoader");
    const request = new Request(url.href, {
      headers: { Accept: "text/x-component" },
    });

    await handleLoaderFetch(
      createMockHandlerCtx(),
      request,
      {},
      url,
      variables,
    );

    expect(capturedMw2Var).toBe("user-42");
  });

  it("loader runs directly when middleware array is empty", async () => {
    vi.mocked(getLoaderLazy).mockResolvedValue({
      fn: testLoaderFn,
      middleware: [],
      fetchable: true,
    });

    const url = new URL("http://localhost/test?_rsc_loader=noMwLoader");
    const request = new Request(url.href, {
      headers: { Accept: "text/x-component" },
    });

    const response = await handleLoaderFetch(
      createMockHandlerCtx(),
      request,
      {},
      url,
      {},
    );

    expect(response.status).toBe(200);
    expect(executionOrder).toEqual(["loader"]);
  });

  it("rejects non-fetchable loaders with 403", async () => {
    vi.mocked(getLoaderLazy).mockResolvedValue({
      fn: testLoaderFn,
      middleware: [],
      fetchable: false,
    });

    const url = new URL("http://localhost/test?_rsc_loader=nonFetchableLoader");
    const request = new Request(url.href, {
      headers: { Accept: "text/x-component" },
    });

    const response = await handleLoaderFetch(
      createMockHandlerCtx(),
      request,
      {},
      url,
      {},
    );

    expect(response.status).toBe(403);
    expect(await response.text()).toContain("is not fetchable");
    // Loader never ran
    expect(executionOrder).toEqual([]);
    expect(capturedCtx).toBeNull();
  });
});
