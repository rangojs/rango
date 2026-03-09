/**
 * Tests that MiddlewareContext.routeName is a lazy getter that re-derives
 * from the request context on each access.
 *
 * Global middleware is created before route matching, so an eagerly-captured
 * value would always be undefined. The getter ensures that after await next()
 * the matched route name is visible.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mutable ref so tests can change what _getRequestContext returns mid-test.
const reqCtxRef: { value: any } = { value: undefined };

vi.mock("../../server/request-context.js", () => ({
  _getRequestContext: () => reqCtxRef.value,
}));

import { createMiddlewareContext } from "../middleware.js";

function makeResponseHolder() {
  const res = new Response(null, { status: 200 });
  return { response: res };
}

describe("MiddlewareContext.routeName", () => {
  beforeEach(() => {
    reqCtxRef.value = undefined;
  });

  it("returns undefined when request context has no route name", () => {
    reqCtxRef.value = {};
    const ctx = createMiddlewareContext(
      new Request("http://localhost/test"),
      {},
      {},
      {},
      makeResponseHolder(),
    );
    expect(ctx.routeName).toBeUndefined();
  });

  it("returns the named route from request context", () => {
    reqCtxRef.value = { _routeName: "blog.post" };
    const ctx = createMiddlewareContext(
      new Request("http://localhost/blog/hello"),
      {},
      {},
      {},
      makeResponseHolder(),
    );
    expect(ctx.routeName).toBe("blog.post");
  });

  it("filters out auto-generated route names", () => {
    reqCtxRef.value = { _routeName: "$path__health" };
    const ctx = createMiddlewareContext(
      new Request("http://localhost/health"),
      {},
      {},
      {},
      makeResponseHolder(),
    );
    expect(ctx.routeName).toBeUndefined();
  });

  it("reflects route name that appears after context creation (global middleware)", () => {
    // Simulate global middleware: request context exists but no route matched yet.
    reqCtxRef.value = {};
    const ctx = createMiddlewareContext(
      new Request("http://localhost/blog/hello"),
      {},
      {},
      {},
      makeResponseHolder(),
    );

    // Before route matching: routeName is undefined
    expect(ctx.routeName).toBeUndefined();

    // Simulate route matching populating the request context
    reqCtxRef.value = { _routeName: "blog.post" };

    // After route matching: getter picks up the new value
    expect(ctx.routeName).toBe("blog.post");
  });
});
