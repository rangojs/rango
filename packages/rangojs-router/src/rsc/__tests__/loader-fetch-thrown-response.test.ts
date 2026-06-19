import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Configurable loader: each test sets `loaderImpl` before invoking the handler.
let loaderImpl: (ctx: any) => unknown = async () => ({ ok: true });

vi.mock("../../server/loader-registry.js", () => ({
  getLoaderLazy: vi.fn(async () => ({
    fn: (ctx: any) => loaderImpl(ctx),
    // No middleware: executeLoaderMiddleware returns finalHandler() directly,
    // so a thrown Response from the loader propagates straight to the catch in
    // handleLoaderFetch (the D4 path).
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
    _getRequestContext: make,
  };
});

// No middleware -> pass straight to the final handler (mirrors middleware.ts
// behavior when the middleware list is empty).
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

// Pass-through helpers so the returned Response is observable directly.
vi.mock("../helpers.js", () => ({
  createResponseWithMergedHeaders: (body: any, init: any) =>
    new Response(body, init),
  finalizeResponse: (r: Response) => r,
}));

import { handleLoaderFetch } from "../loader-fetch";
import { notFound } from "../../errors.js";

// Capture what renderToReadableStream is asked to serialize (the error payload).
let serializedPayloads: unknown[] = [];

function createMockHandlerCtx() {
  return {
    renderToReadableStream: (payload: unknown) => {
      serializedPayloads.push(payload);
      return new ReadableStream();
    },
    callOnError: vi.fn(),
    getRequiredRouteMap: () => ({}),
  } as any;
}

function loaderRequest(): { request: Request; url: URL } {
  const url = new URL("http://localhost/products?_rsc_loader=myLoader");
  const request = new Request(url.href, {
    headers: { Accept: "text/x-component" },
  });
  return { request, url };
}

describe("handleLoaderFetch — thrown Response from a no-middleware loader (D4)", () => {
  beforeEach(() => {
    serializedPayloads = [];
  });

  it("honors a thrown 302 redirect Response instead of a generic 500", async () => {
    // `throw redirect('/login')` throws a real Response. Without the fix this
    // becomes new Error('[object Response]') -> 500 RSC error payload.
    loaderImpl = async () => {
      throw new Response(null, {
        status: 302,
        headers: { Location: "/login" },
      });
    };
    const { request, url } = loaderRequest();

    const res = await handleLoaderFetch(
      createMockHandlerCtx(),
      request,
      {},
      url,
      {},
    );

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/login");
    // No error payload was serialized — the redirect short-circuited.
    expect(serializedPayloads).toHaveLength(0);
  });

  it("honors a thrown 404 notFound Response", async () => {
    loaderImpl = async () => {
      throw new Response(null, { status: 404 });
    };
    const { request, url } = loaderRequest();

    const res = await handleLoaderFetch(
      createMockHandlerCtx(),
      request,
      {},
      url,
      {},
    );

    expect(res.status).toBe(404);
    expect(serializedPayloads).toHaveLength(0);
  });

  it("maps a real notFound() (DataNotFoundError) to a 404, not a 500", async () => {
    // notFound() throws a DataNotFoundError (an Error subclass, NOT a Response),
    // so the `error instanceof Response` branch misses it. Without the
    // DataNotFoundError mapping it falls through to the generic coercion and
    // returns a 500 — even though the comment claims notFound() is honored.
    loaderImpl = async () => {
      notFound("Product not found");
    };
    const { request, url } = loaderRequest();

    const res = await handleLoaderFetch(
      createMockHandlerCtx(),
      request,
      {},
      url,
      {},
    );

    expect(res.status).toBe(404);
  });
});

describe("handleLoaderFetch — error payload name disclosure (D5)", () => {
  const ORIGINAL_ENV = process.env.NODE_ENV;

  beforeEach(() => {
    serializedPayloads = [];
  });

  afterEach(() => {
    process.env.NODE_ENV = ORIGINAL_ENV;
  });

  function throwCustom() {
    class AuthError extends Error {
      constructor(msg: string) {
        super(msg);
        this.name = "AuthError";
      }
    }
    loaderImpl = async () => {
      throw new AuthError("secret detail");
    };
  }

  it("does NOT leak the custom error class name in production", async () => {
    process.env.NODE_ENV = "production";
    throwCustom();
    const { request, url } = loaderRequest();

    const res = await handleLoaderFetch(
      createMockHandlerCtx(),
      request,
      {},
      url,
      {},
    );

    expect(res.status).toBe(500);
    expect(serializedPayloads).toHaveLength(1);
    const payload = serializedPayloads[0] as {
      loaderError: { message: string; name: string };
    };
    // name must NOT be the consumer's class; message is the generic prod string.
    expect(payload.loaderError.name).toBe("Error");
    expect(payload.loaderError.name).not.toBe("AuthError");
    expect(payload.loaderError.message).toBe("An error occurred");
  });

  it("still surfaces the real name + message in development", async () => {
    process.env.NODE_ENV = "development";
    throwCustom();
    const { request, url } = loaderRequest();

    await handleLoaderFetch(createMockHandlerCtx(), request, {}, url, {});

    const payload = serializedPayloads[0] as {
      loaderError: { message: string; name: string };
    };
    expect(payload.loaderError.name).toBe("AuthError");
    expect(payload.loaderError.message).toBe("secret detail");
  });
});
