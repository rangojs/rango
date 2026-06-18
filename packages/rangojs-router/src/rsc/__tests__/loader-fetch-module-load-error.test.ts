import { describe, it, expect, vi, beforeEach } from "vitest";

// H1: a loader module that FAILS to import must surface as a 500 + onError,
// not be collapsed into a misleading 404. getLoaderLazy is mocked to throw,
// simulating a broken transitive import / syntax error / top-level throw.

let serializedPayloads: unknown[] = [];

vi.mock("../../server/loader-registry.js", () => ({
  getLoaderLazy: vi.fn(async () => {
    throw new Error("broken transitive import");
  }),
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

function createMockHandlerCtx(onError: ReturnType<typeof vi.fn>) {
  return {
    renderToReadableStream: (payload: unknown) => {
      serializedPayloads.push(payload);
      return new ReadableStream();
    },
    callOnError: onError,
    getRequiredRouteMap: () => ({}),
  } as any;
}

function loaderRequest(): { request: Request; url: URL } {
  const url = new URL("http://localhost/products?_rsc_loader=brokenLoader");
  const request = new Request(url.href, {
    headers: { Accept: "text/x-component" },
  });
  return { request, url };
}

describe("handleLoaderFetch — loader module load failure (H1)", () => {
  beforeEach(() => {
    serializedPayloads = [];
  });

  it("returns 500 (not 404) and fires onError when the loader import throws", async () => {
    const onError = vi.fn();
    const { request, url } = loaderRequest();

    const res = await handleLoaderFetch(
      createMockHandlerCtx(onError),
      request,
      {},
      url,
      {},
    );

    // A genuine module-load failure is a server error, not a not-found.
    expect(res.status).toBe(500);
    expect(res.status).not.toBe(404);

    // onError must fire with phase "loader" so consumer telemetry sees it.
    expect(onError).toHaveBeenCalled();
    const [, phase] = onError.mock.calls[0];
    expect(phase).toBe("loader");

    // An RSC error payload was serialized (not a plain 404 body).
    expect(serializedPayloads).toHaveLength(1);
    const payload = serializedPayloads[0] as { loaderError: unknown };
    expect(payload.loaderError).toBeTruthy();
  });
});
