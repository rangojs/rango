import { describe, it, expect } from "vitest";
import {
  executeMiddleware,
  executeInterceptMiddleware,
} from "../middleware.js";
import type { MiddlewareEntry, MiddlewareFn } from "../middleware-types.js";

// A thrown Response from middleware is control flow, not an error. It must be
// treated exactly like `return new Response(...)`: header/cookie stubs set
// earlier via ctx.header()/ctx.setCookie() merge onto the short-circuit
// response. Without this, consumers who `throw new Response(...)` (per the
// public docs and the middleware skill) leak the raw throw to the host
// (miniflare in CF, Node's fetch adapter), which stringifies it as 500.

function entry(handler: MiddlewareFn): {
  entry: MiddlewareEntry;
  params: Record<string, string>;
} {
  return {
    entry: {
      pattern: null,
      regex: null,
      paramNames: [],
      handler,
    },
    params: {},
  };
}

describe("executeMiddleware: thrown Response short-circuit", () => {
  it("returns the thrown Response with its status + body", async () => {
    const mw: MiddlewareFn = () => {
      throw new Response("thrown-body", {
        status: 418,
        headers: { "X-Thrown": "yes" },
      });
    };

    const finalHandler = async () =>
      new Response("should-not-run", { status: 200 });

    const response = await executeMiddleware(
      [entry(mw)],
      new Request("http://localhost/"),
      {},
      {},
      finalHandler,
    );

    expect(response.status).toBe(418);
    expect(await response.text()).toBe("thrown-body");
    expect(response.headers.get("X-Thrown")).toBe("yes");
  });

  it("merges ctx.header() stubs onto a thrown Response", async () => {
    const mw: MiddlewareFn = (ctx) => {
      ctx.header("X-Stub-Before-Throw", "from-stub");
      throw new Response("thrown-body", {
        status: 401,
        headers: { "X-From-Throw": "from-throw" },
      });
    };

    const response = await executeMiddleware(
      [entry(mw)],
      new Request("http://localhost/"),
      {},
      {},
      async () => new Response("unreached"),
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("X-Stub-Before-Throw")).toBe("from-stub");
    expect(response.headers.get("X-From-Throw")).toBe("from-throw");
  });

  it("explicit response header wins over stub header of same name", async () => {
    const mw: MiddlewareFn = (ctx) => {
      ctx.header("X-Conflict", "from-stub");
      throw new Response(null, {
        status: 403,
        headers: { "X-Conflict": "from-throw" },
      });
    };

    const response = await executeMiddleware(
      [entry(mw)],
      new Request("http://localhost/"),
      {},
      {},
      async () => new Response("unreached"),
    );

    expect(response.headers.get("X-Conflict")).toBe("from-throw");
  });

  it("stub Set-Cookie entries append onto a thrown Response", async () => {
    const mw: MiddlewareFn = (ctx) => {
      ctx.header("Set-Cookie", "stub=1; Path=/");
      throw new Response(null, {
        status: 302,
        headers: { "Set-Cookie": "thrown=2; Path=/", Location: "/" },
      });
    };

    const response = await executeMiddleware(
      [entry(mw)],
      new Request("http://localhost/"),
      {},
      {},
      async () => new Response("unreached"),
    );

    const cookies = response.headers.getSetCookie();
    expect(cookies).toContain("stub=1; Path=/");
    expect(cookies).toContain("thrown=2; Path=/");
  });

  it("non-Response throws still propagate as errors", async () => {
    const mw: MiddlewareFn = () => {
      throw new Error("real error");
    };

    await expect(
      executeMiddleware(
        [entry(mw)],
        new Request("http://localhost/"),
        {},
        {},
        async () => new Response("unreached"),
      ),
    ).rejects.toThrow("real error");
  });

  it("thrown Response from downstream mw short-circuits upstream mw", async () => {
    // Outer mw calls next() and lets the downstream throw propagate. The
    // outer composer frame must still treat that thrown Response as control
    // flow, not an error.
    const outer: MiddlewareFn = async (_ctx, next) => {
      return await next();
    };
    const inner: MiddlewareFn = () => {
      throw new Response("from-inner", {
        status: 418,
        headers: { "X-Inner": "yes" },
      });
    };

    const response = await executeMiddleware(
      [entry(outer), entry(inner)],
      new Request("http://localhost/"),
      {},
      {},
      async () => new Response("unreached"),
    );

    expect(response.status).toBe(418);
    expect(await response.text()).toBe("from-inner");
    expect(response.headers.get("X-Inner")).toBe("yes");
  });
});

describe("executeInterceptMiddleware: thrown Response short-circuit", () => {
  it("returns the thrown Response and merges stub headers", async () => {
    const middleware: MiddlewareFn = (ctx) => {
      ctx.header("X-Stub", "stub-value");
      throw new Response("thrown-intercept", {
        status: 418,
        headers: { "X-Thrown": "yes" },
      });
    };

    const stubResponse = new Response(null);
    const result = await executeInterceptMiddleware(
      [middleware],
      new Request("http://localhost/"),
      {},
      {},
      {},
      stubResponse,
    );

    expect(result).toBeInstanceOf(Response);
    expect(result!.status).toBe(418);
    expect(await result!.text()).toBe("thrown-intercept");
    expect(result!.headers.get("X-Thrown")).toBe("yes");
    expect(result!.headers.get("X-Stub")).toBe("stub-value");
  });

  it("non-Response throws still propagate as errors", async () => {
    const middleware: MiddlewareFn = () => {
      throw new Error("real error");
    };

    await expect(
      executeInterceptMiddleware(
        [middleware],
        new Request("http://localhost/"),
        {},
        {},
        {},
        new Response(null),
      ),
    ).rejects.toThrow("real error");
  });
});
