import { describe, it, expect } from "vitest";
import { executeInterceptMiddleware } from "../middleware.js";
import type { MiddlewareFn } from "../middleware-types.js";

describe("executeInterceptMiddleware header precedence", () => {
  it("explicit response headers take precedence over stub headers", async () => {
    // Middleware that sets a header on ctx.header() (written to stub),
    // then short-circuits with a Response that carries the SAME header name.
    const middleware: MiddlewareFn = (ctx) => {
      ctx.header("X-Custom", "from-stub");
      return new Response("short-circuit", {
        headers: { "X-Custom": "from-response" },
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
    // The response's explicit header must win over the stub header
    expect(result!.headers.get("X-Custom")).toBe("from-response");
  });

  it("stub headers fill in missing headers on the response", async () => {
    // Middleware writes a header via ctx (stub), then returns a response
    // WITHOUT that header — stub should fill the gap.
    const middleware: MiddlewareFn = (ctx) => {
      ctx.header("X-Stub-Only", "stub-value");
      return new Response("short-circuit", {
        headers: { "X-Response-Only": "response-value" },
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
    expect(result!.headers.get("X-Stub-Only")).toBe("stub-value");
    expect(result!.headers.get("X-Response-Only")).toBe("response-value");
  });

  it("Set-Cookie headers are always appended from stub", async () => {
    const middleware: MiddlewareFn = (ctx) => {
      ctx.header("Set-Cookie", "stub=1");
      return new Response("short-circuit", {
        headers: { "Set-Cookie": "response=2" },
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
    const cookies = result!.headers.getSetCookie();
    expect(cookies).toContain("response=2");
    expect(cookies).toContain("stub=1");
  });
});
