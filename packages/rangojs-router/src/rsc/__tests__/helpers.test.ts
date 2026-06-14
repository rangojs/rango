/**
 * Tests for RSC helpers
 */
import { describe, it, expect } from "vitest";
import {
  createRequestContext,
  runWithRequestContext,
} from "../../server/request-context.js";
import {
  createResponseWithMergedHeaders,
  createSimpleRedirectResponse,
  finalizeResponse,
  interceptRedirectForPartial,
  carryOverRedirectHeaders,
} from "../helpers.js";
import { isWebSocketUpgradeResponse } from "../../response-utils.js";
import { EXTERNAL_REDIRECT_MARKER } from "../../redirect-origin.js";

describe("createResponseWithMergedHeaders", () => {
  it("should create response without context", () => {
    const response = createResponseWithMergedHeaders("body", { status: 200 });
    expect(response.status).toBe(200);
  });

  it("should merge headers from stub response", () => {
    const ctx = createRequestContext({
      env: {},
      request: new Request("https://example.com"),
      url: new URL("https://example.com"),
      variables: {},
    });

    // Set header on stub response
    ctx.res.headers.set("X-Custom", "value");

    const response = runWithRequestContext(ctx, () => {
      return createResponseWithMergedHeaders("body", { status: 200 });
    });

    expect(response.headers.get("X-Custom")).toBe("value");
  });

  it("should trigger onResponse callbacks", () => {
    const ctx = createRequestContext({
      env: {},
      request: new Request("https://example.com"),
      url: new URL("https://example.com"),
      variables: {},
    });

    let callbackCalled = false;
    let capturedStatus: number | undefined;

    ctx.onResponse((res) => {
      callbackCalled = true;
      capturedStatus = res.status;
      return res;
    });

    runWithRequestContext(ctx, () => {
      createResponseWithMergedHeaders("body", { status: 201 });
    });

    expect(callbackCalled).toBe(true);
    expect(capturedStatus).toBe(201);
  });

  it("should allow callbacks to modify response", () => {
    const ctx = createRequestContext({
      env: {},
      request: new Request("https://example.com"),
      url: new URL("https://example.com"),
      variables: {},
    });

    ctx.onResponse((res) => {
      const headers = new Headers(res.headers);
      headers.set("X-Added-By-Callback", "yes");
      return new Response(res.body, { status: res.status, headers });
    });

    const response = runWithRequestContext(ctx, () => {
      return createResponseWithMergedHeaders("body", { status: 200 });
    });

    expect(response.headers.get("X-Added-By-Callback")).toBe("yes");
  });

  it("should keep original response if callback returns undefined", () => {
    const ctx = createRequestContext({
      env: {},
      request: new Request("https://example.com"),
      url: new URL("https://example.com"),
      variables: {},
    });

    ctx.onResponse((_res) => {
      // Oops, forgot to return response
      return undefined as any;
    });

    const response = runWithRequestContext(ctx, () => {
      return createResponseWithMergedHeaders("body", { status: 200 });
    });

    expect(response.status).toBe(200);
  });

  it("should chain multiple callback modifications", () => {
    const ctx = createRequestContext({
      env: {},
      request: new Request("https://example.com"),
      url: new URL("https://example.com"),
      variables: {},
    });

    ctx.onResponse((res) => {
      const headers = new Headers(res.headers);
      headers.set("X-First", "1");
      return new Response(res.body, { status: res.status, headers });
    });

    ctx.onResponse((res) => {
      const headers = new Headers(res.headers);
      headers.set("X-Second", "2");
      return new Response(res.body, { status: res.status, headers });
    });

    const response = runWithRequestContext(ctx, () => {
      return createResponseWithMergedHeaders("body", { status: 200 });
    });

    expect(response.headers.get("X-First")).toBe("1");
    expect(response.headers.get("X-Second")).toBe("2");
  });

  it("should pass correct status to callbacks for error responses", () => {
    const ctx = createRequestContext({
      env: {},
      request: new Request("https://example.com"),
      url: new URL("https://example.com"),
      variables: {},
    });

    const capturedStatuses: number[] = [];

    ctx.onResponse((res) => {
      capturedStatuses.push(res.status);
      return res;
    });

    runWithRequestContext(ctx, () => {
      createResponseWithMergedHeaders("Not Found", { status: 404 });
    });

    expect(capturedStatuses).toEqual([404]);
  });

  it("should pass correct status to callbacks for redirects", () => {
    const ctx = createRequestContext({
      env: {},
      request: new Request("https://example.com"),
      url: new URL("https://example.com"),
      variables: {},
    });

    let capturedStatus: number | undefined;

    ctx.onResponse((res) => {
      capturedStatus = res.status;
      return res;
    });

    runWithRequestContext(ctx, () => {
      createResponseWithMergedHeaders(null, {
        status: 308,
        headers: { Location: "/new-url" },
      });
    });

    expect(capturedStatus).toBe(308);
  });
});

describe("redirect + cookie/header preservation", () => {
  it("preserves ctx.setCookie in redirect response", () => {
    const ctx = createRequestContext({
      env: {},
      request: new Request("https://example.com"),
      url: new URL("https://example.com"),
      variables: {},
    });

    ctx.setCookie("session", "tok-123", { path: "/", httpOnly: true });

    const response = runWithRequestContext(ctx, () =>
      createResponseWithMergedHeaders(null, {
        status: 302,
        headers: { Location: "/dashboard" },
      }),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/dashboard");
    const cookies = response.headers.getSetCookie();
    expect(cookies.some((c) => c.includes("session=tok-123"))).toBe(true);
    expect(cookies.some((c) => c.includes("HttpOnly"))).toBe(true);
  });

  it("preserves multiple ctx.setCookie calls in redirect response", () => {
    const ctx = createRequestContext({
      env: {},
      request: new Request("https://example.com"),
      url: new URL("https://example.com"),
      variables: {},
    });

    ctx.setCookie("session", "s1", { path: "/" });
    ctx.setCookie("theme", "dark", { path: "/" });

    const response = runWithRequestContext(ctx, () =>
      createResponseWithMergedHeaders(null, {
        status: 302,
        headers: { Location: "/home" },
      }),
    );

    const cookies = response.headers.getSetCookie();
    expect(cookies.some((c) => c.includes("session=s1"))).toBe(true);
    expect(cookies.some((c) => c.includes("theme=dark"))).toBe(true);
  });

  it("preserves ctx.header in redirect response", () => {
    const ctx = createRequestContext({
      env: {},
      request: new Request("https://example.com"),
      url: new URL("https://example.com"),
      variables: {},
    });

    ctx.header("X-Middleware-Applied", "auth");
    ctx.header("X-Request-Id", "req-456");

    const response = runWithRequestContext(ctx, () =>
      createResponseWithMergedHeaders(null, {
        status: 302,
        headers: { Location: "/protected" },
      }),
    );

    expect(response.headers.get("X-Middleware-Applied")).toBe("auth");
    expect(response.headers.get("X-Request-Id")).toBe("req-456");
  });

  it("preserves both cookies and headers in redirect response", () => {
    const ctx = createRequestContext({
      env: {},
      request: new Request("https://example.com"),
      url: new URL("https://example.com"),
      variables: {},
    });

    ctx.setCookie("auth", "token-abc", { path: "/", httpOnly: true });
    ctx.header("X-Custom", "value");

    const response = runWithRequestContext(ctx, () =>
      createResponseWithMergedHeaders(null, {
        status: 307,
        headers: { Location: "/next" },
      }),
    );

    expect(response.status).toBe(307);
    const cookies = response.headers.getSetCookie();
    expect(cookies.some((c) => c.includes("auth=token-abc"))).toBe(true);
    expect(response.headers.get("X-Custom")).toBe("value");
  });

  it("createSimpleRedirectResponse preserves ctx-set cookies and headers", () => {
    const ctx = createRequestContext({
      env: {},
      request: new Request("https://example.com"),
      url: new URL("https://example.com"),
      variables: {},
    });

    ctx.setCookie("session", "val", { path: "/" });
    ctx.header("X-From-Middleware", "yes");

    const response = runWithRequestContext(ctx, () =>
      createSimpleRedirectResponse("/target"),
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("X-RSC-Redirect")).toBe("/target");
    const cookies = response.headers.getSetCookie();
    expect(cookies.some((c) => c.includes("session=val"))).toBe(true);
    expect(response.headers.get("X-From-Middleware")).toBe("yes");
  });

  it("init headers take precedence over ctx headers for non-cookie values", () => {
    const ctx = createRequestContext({
      env: {},
      request: new Request("https://example.com"),
      url: new URL("https://example.com"),
      variables: {},
    });

    ctx.header("X-Source", "middleware");

    const response = runWithRequestContext(ctx, () =>
      createResponseWithMergedHeaders(null, {
        status: 200,
        headers: { "X-Source": "handler" },
      }),
    );

    expect(response.headers.get("X-Source")).toBe("handler");
  });

  it("onResponse callbacks fire on redirect responses and can modify them", () => {
    const ctx = createRequestContext({
      env: {},
      request: new Request("https://example.com"),
      url: new URL("https://example.com"),
      variables: {},
    });

    ctx.setCookie("original", "keep", { path: "/" });
    ctx.onResponse((res) => {
      const headers = new Headers(res.headers);
      headers.set("X-Added-By-Callback", "yes");
      return new Response(res.body, { status: res.status, headers });
    });

    const response = runWithRequestContext(ctx, () =>
      createResponseWithMergedHeaders(null, {
        status: 302,
        headers: { Location: "/redirected" },
      }),
    );

    expect(response.headers.get("X-Added-By-Callback")).toBe("yes");
    expect(response.headers.get("Location")).toBe("/redirected");
    const cookies = response.headers.getSetCookie();
    expect(cookies.some((c) => c.includes("original=keep"))).toBe(true);
  });

  it("ctx.deleteCookie is preserved through redirect response", () => {
    const ctx = createRequestContext({
      env: {},
      request: new Request("https://example.com", {
        headers: { Cookie: "stale=old" },
      }),
      url: new URL("https://example.com"),
      variables: {},
    });

    ctx.deleteCookie("stale", { path: "/" });

    const response = runWithRequestContext(ctx, () =>
      createResponseWithMergedHeaders(null, {
        status: 302,
        headers: { Location: "/clean" },
      }),
    );

    const cookies = response.headers.getSetCookie();
    expect(
      cookies.some((c) => c.includes("stale=") && c.includes("Max-Age=0")),
    ).toBe(true);
  });
});

describe("error boundary status + middleware header preservation", () => {
  it("ctx.setStatus(500) overrides init status while preserving cookies", () => {
    const ctx = createRequestContext({
      env: {},
      request: new Request("https://example.com"),
      url: new URL("https://example.com"),
      variables: {},
    });

    // Middleware sets a cookie before handler runs
    ctx.setCookie("trace", "req-001", { path: "/" });
    // Error boundary sets 500
    ctx.setStatus(500);

    const response = runWithRequestContext(ctx, () =>
      createResponseWithMergedHeaders("error boundary content", {
        status: 200,
        headers: { "content-type": "text/x-component;charset=utf-8" },
      }),
    );

    // Status from ctx.res overrides init when non-200
    expect(response.status).toBe(500);
    // Middleware cookies survive the error boundary status change
    const cookies = response.headers.getSetCookie();
    expect(cookies.some((c) => c.includes("trace=req-001"))).toBe(true);
    expect(response.headers.get("content-type")).toBe(
      "text/x-component;charset=utf-8",
    );
  });

  it("ctx.setStatus(404) with cookies and onResponse callbacks all work together", () => {
    const ctx = createRequestContext({
      env: {},
      request: new Request("https://example.com/missing"),
      url: new URL("https://example.com/missing"),
      variables: {},
    });

    ctx.setCookie("session", "active", { path: "/" });
    ctx.header("X-Trace", "t-404");
    ctx.setStatus(404);

    let callbackSawStatus: number | undefined;
    ctx.onResponse((res) => {
      callbackSawStatus = res.status;
      return res;
    });

    const response = runWithRequestContext(ctx, () =>
      createResponseWithMergedHeaders("not found content", {
        status: 200,
      }),
    );

    expect(response.status).toBe(404);
    expect(callbackSawStatus).toBe(404);
    const cookies = response.headers.getSetCookie();
    expect(cookies.some((c) => c.includes("session=active"))).toBe(true);
    expect(response.headers.get("X-Trace")).toBe("t-404");
  });

  it("ctx.setStatus does not override when status is 200 (default)", () => {
    const ctx = createRequestContext({
      env: {},
      request: new Request("https://example.com"),
      url: new URL("https://example.com"),
      variables: {},
    });

    // Don't call setStatus — ctx.res.status remains 200
    const response = runWithRequestContext(ctx, () =>
      createResponseWithMergedHeaders(null, {
        status: 302,
        headers: { Location: "/other" },
      }),
    );

    // init status wins when ctx.res.status is 200
    expect(response.status).toBe(302);
  });

  it("middleware cookies survive when handler produces redirect and ctx has non-200 status", () => {
    const ctx = createRequestContext({
      env: {},
      request: new Request("https://example.com"),
      url: new URL("https://example.com"),
      variables: {},
    });

    ctx.setCookie("auth", "jwt-xyz", { path: "/", httpOnly: true });
    ctx.header("X-Request-Id", "r-789");
    // Simulate a scenario where status was set to 401 before redirect
    ctx.setStatus(401);

    const response = runWithRequestContext(ctx, () =>
      createResponseWithMergedHeaders(null, {
        status: 200,
        headers: { Location: "/login" },
      }),
    );

    // Non-200 ctx status overrides
    expect(response.status).toBe(401);
    expect(response.headers.get("Location")).toBe("/login");
    const cookies = response.headers.getSetCookie();
    expect(cookies.some((c) => c.includes("auth=jwt-xyz"))).toBe(true);
    expect(cookies.some((c) => c.includes("HttpOnly"))).toBe(true);
    expect(response.headers.get("X-Request-Id")).toBe("r-789");
  });
});

describe("content negotiation edge cases", () => {
  it("interceptRedirectForPartial preserves cookies and headers from redirect response", () => {
    const ctx = createRequestContext({
      env: {},
      request: new Request("https://example.com"),
      url: new URL("https://example.com"),
      variables: {},
    });

    const result = runWithRequestContext(ctx, () => {
      const redirectResponse = new Response(null, {
        status: 302,
        headers: {
          Location: "/dashboard",
          "Set-Cookie": "session=renewed; Path=/; HttpOnly",
          "X-Custom-Tracking": "track-123",
        },
      });

      return interceptRedirectForPartial(
        redirectResponse,
        (url) =>
          new Response(null, {
            status: 204,
            headers: { "X-RSC-Redirect": url },
          }),
      );
    });

    expect(result).not.toBeNull();
    expect(result!.status).toBe(204);
    expect(result!.headers.get("X-RSC-Redirect")).toBe("/dashboard");
    const cookies = result!.headers.getSetCookie();
    expect(cookies.some((c) => c.includes("session=renewed"))).toBe(true);
    expect(result!.headers.get("X-Custom-Tracking")).toBe("track-123");
  });

  it("interceptRedirectForPartial with ctx-set cookies and redirect cookies are merged", () => {
    const ctx = createRequestContext({
      env: {},
      request: new Request("https://example.com"),
      url: new URL("https://example.com"),
      variables: {},
    });

    ctx.setCookie("middleware-cookie", "mw-val", { path: "/" });

    const result = runWithRequestContext(ctx, () => {
      // Simulate a redirect response that itself sets cookies
      const redirectResponse = new Response(null, {
        status: 307,
        headers: {
          Location: "/next",
          "Set-Cookie": "redirect-cookie=rd-val; Path=/",
        },
      });

      return interceptRedirectForPartial(redirectResponse, (url) =>
        // The createSimpleRedirectResponse path — uses merged headers
        createSimpleRedirectResponse(url),
      );
    });

    expect(result).not.toBeNull();
    expect(result!.headers.get("X-RSC-Redirect")).toBe("/next");
    const cookies = result!.headers.getSetCookie();
    // Both ctx-set and redirect-set cookies should be present
    expect(cookies.some((c) => c.includes("middleware-cookie=mw-val"))).toBe(
      true,
    );
    expect(cookies.some((c) => c.includes("redirect-cookie=rd-val"))).toBe(
      true,
    );
  });

  it("finalizeResponse runs onResponse callbacks on middleware short-circuit response", () => {
    const ctx = createRequestContext({
      env: {},
      request: new Request("https://example.com/api/data"),
      url: new URL("https://example.com/api/data"),
      variables: {},
    });

    let callbackFired = false;
    ctx.onResponse((res) => {
      callbackFired = true;
      const headers = new Headers(res.headers);
      headers.set("X-Finalized", "true");
      return new Response(res.body, { status: res.status, headers });
    });

    // Simulate middleware short-circuit returning a pre-built response
    const shortCircuitResponse = new Response('{"data":"ok"}', {
      status: 200,
      headers: { "content-type": "application/json" },
    });

    const result = runWithRequestContext(ctx, () =>
      finalizeResponse(shortCircuitResponse),
    );

    expect(callbackFired).toBe(true);
    expect(result.headers.get("X-Finalized")).toBe("true");
    expect(result.headers.get("content-type")).toBe("application/json");
  });

  it("createSimpleRedirectResponse always produces 204 with X-RSC-Redirect", () => {
    // Without request context
    const response = createSimpleRedirectResponse("/target-path");
    expect(response.status).toBe(204);
    expect(response.headers.get("X-RSC-Redirect")).toBe("/target-path");
  });

  it("non-200 ctx.setStatus overrides createSimpleRedirectResponse 204 status", () => {
    const ctx = createRequestContext({
      env: {},
      request: new Request("https://example.com"),
      url: new URL("https://example.com"),
      variables: {},
    });

    // createResponseWithMergedHeaders uses ctx.res.status when non-200,
    // so setStatus(401) wins over the 204 passed by createSimpleRedirectResponse.
    ctx.setStatus(401);

    const response = runWithRequestContext(ctx, () =>
      createSimpleRedirectResponse("/login"),
    );

    expect(response.headers.get("X-RSC-Redirect")).toBe("/login");
    expect(response.status).toBe(401);
  });
});

describe("finalizeResponse", () => {
  it("should return response unchanged when no request context", () => {
    const response = new Response("body", { status: 200 });
    const result = finalizeResponse(response);
    expect(result).toBe(response);
  });

  it("should return response unchanged when no callbacks registered", () => {
    const ctx = createRequestContext({
      env: {},
      request: new Request("https://example.com"),
      url: new URL("https://example.com"),
      variables: {},
    });

    const response = new Response("body", { status: 200 });
    const result = runWithRequestContext(ctx, () => finalizeResponse(response));
    expect(result).toBe(response);
  });

  it("should run single onResponse callback", () => {
    const ctx = createRequestContext({
      env: {},
      request: new Request("https://example.com"),
      url: new URL("https://example.com"),
      variables: {},
    });

    ctx.onResponse((res) => {
      const headers = new Headers(res.headers);
      headers.set("X-Test", "applied");
      return new Response(res.body, { status: res.status, headers });
    });

    const response = new Response("body", { status: 200 });
    const result = runWithRequestContext(ctx, () => finalizeResponse(response));
    expect(result.headers.get("X-Test")).toBe("applied");
  });

  it("should chain multiple callbacks in order", () => {
    const ctx = createRequestContext({
      env: {},
      request: new Request("https://example.com"),
      url: new URL("https://example.com"),
      variables: {},
    });

    const order: number[] = [];
    ctx.onResponse((res) => {
      order.push(1);
      const headers = new Headers(res.headers);
      headers.set("X-First", "1");
      return new Response(res.body, { status: res.status, headers });
    });
    ctx.onResponse((res) => {
      order.push(2);
      const headers = new Headers(res.headers);
      headers.set("X-Second", "2");
      return new Response(res.body, { status: res.status, headers });
    });

    const response = new Response("body", { status: 200 });
    const result = runWithRequestContext(ctx, () => finalizeResponse(response));
    expect(order).toEqual([1, 2]);
    expect(result.headers.get("X-First")).toBe("1");
    expect(result.headers.get("X-Second")).toBe("2");
  });

  it("should handle callback returning undefined", () => {
    const ctx = createRequestContext({
      env: {},
      request: new Request("https://example.com"),
      url: new URL("https://example.com"),
      variables: {},
    });

    let called = false;
    ctx.onResponse((_res) => {
      called = true;
      return undefined as any;
    });

    const response = new Response("body", { status: 201 });
    const result = runWithRequestContext(ctx, () => finalizeResponse(response));
    expect(called).toBe(true);
    expect(result).toBe(response);
  });
});

describe("onResponse callback drain semantics", () => {
  it("createResponseWithMergedHeaders drains callbacks so finalizeResponse is a no-op", () => {
    const ctx = createRequestContext({
      env: {},
      request: new Request("https://example.com"),
      url: new URL("https://example.com"),
      variables: {},
    });

    let callCount = 0;
    ctx.onResponse((res) => {
      callCount++;
      return res;
    });

    const result = runWithRequestContext(ctx, () => {
      // First call — callback fires and is drained
      const response = createResponseWithMergedHeaders("body", { status: 200 });
      // Second call via finalizeResponse — should NOT re-fire
      return finalizeResponse(response);
    });

    expect(callCount).toBe(1);
    expect(result.status).toBe(200);
  });

  it("finalizeResponse drains callbacks so a second call is a no-op", () => {
    const ctx = createRequestContext({
      env: {},
      request: new Request("https://example.com"),
      url: new URL("https://example.com"),
      variables: {},
    });

    let callCount = 0;
    ctx.onResponse((res) => {
      callCount++;
      return res;
    });

    const response = new Response("body", { status: 200 });
    runWithRequestContext(ctx, () => {
      finalizeResponse(response);
      finalizeResponse(response);
    });

    expect(callCount).toBe(1);
  });
});

describe("interceptRedirectForPartial", () => {
  it("returns null for non-redirect responses", () => {
    const response = new Response("ok", { status: 200 });
    const result = interceptRedirectForPartial(response, () => new Response());
    expect(result).toBeNull();
  });

  it("returns null for redirect without Location header", () => {
    const response = new Response(null, { status: 302 });
    const result = interceptRedirectForPartial(response, () => new Response());
    expect(result).toBeNull();
  });

  it("intercepts 3xx redirect and returns simple redirect response", () => {
    const ctx = createRequestContext({
      env: {},
      request: new Request("https://example.com"),
      url: new URL("https://example.com"),
      variables: {},
    });

    const response = new Response(null, {
      status: 302,
      headers: { Location: "/new-page" },
    });

    const result = runWithRequestContext(ctx, () =>
      interceptRedirectForPartial(
        response,
        (url) => new Response(`flight:${url}`),
      ),
    );

    expect(result).not.toBeNull();
    expect(result!.headers.get("X-RSC-Redirect")).toBe("/new-page");
  });

  it("preserves Set-Cookie from original redirect response", () => {
    const ctx = createRequestContext({
      env: {},
      request: new Request("https://example.com"),
      url: new URL("https://example.com"),
      variables: {},
    });

    const headers = new Headers();
    headers.set("Location", "/dashboard");
    headers.append("Set-Cookie", "session=abc123; Path=/; HttpOnly");
    headers.append("Set-Cookie", "theme=dark; Path=/");
    const response = new Response(null, { status: 302, headers });

    const result = runWithRequestContext(ctx, () =>
      interceptRedirectForPartial(
        response,
        (url) => new Response(`flight:${url}`),
      ),
    );

    expect(result).not.toBeNull();
    const cookies = result!.headers.getSetCookie();
    expect(cookies).toContain("session=abc123; Path=/; HttpOnly");
    expect(cookies).toContain("theme=dark; Path=/");
  });

  it("preserves custom headers from original redirect response", () => {
    const ctx = createRequestContext({
      env: {},
      request: new Request("https://example.com"),
      url: new URL("https://example.com"),
      variables: {},
    });

    const response = new Response(null, {
      status: 307,
      headers: {
        Location: "/target",
        "X-Custom-Middleware": "applied",
        "X-Request-Id": "req-123",
      },
    });

    const result = runWithRequestContext(ctx, () =>
      interceptRedirectForPartial(
        response,
        (url) => new Response(`flight:${url}`),
      ),
    );

    expect(result).not.toBeNull();
    expect(result!.headers.get("X-Custom-Middleware")).toBe("applied");
    expect(result!.headers.get("X-Request-Id")).toBe("req-123");
    // Location should not be carried over
    expect(result!.headers.get("Location")).toBeNull();
  });

  it("does not carry X-RSC-Redirect from original 3xx onto Flight response with location state", () => {
    const ctx = createRequestContext({
      env: {},
      request: new Request("https://example.com"),
      url: new URL("https://example.com"),
      variables: {},
    });

    // Set location state so interceptRedirectForPartial takes the
    // createRedirectFlightResponse path (Flight payload with state),
    // not createSimpleRedirectResponse (which sets its own X-RSC-Redirect).
    ctx.setLocationState([
      { __rsc_ls_key: "flash", __rsc_ls_value: { text: "hello" } },
    ]);

    // Original redirect has X-RSC-Redirect: "soft" (from redirect() helper).
    // The Flight response created by createRedirectFlightResponse has its own
    // content; carrying over "soft" would break client-side redirect handling.
    const response = new Response(null, {
      status: 302,
      headers: {
        Location: "/target",
        "X-RSC-Redirect": "soft",
        "X-Custom": "keep-me",
      },
    });

    const result = runWithRequestContext(ctx, () =>
      interceptRedirectForPartial(
        response,
        (url) =>
          new Response(`flight:${url}`, {
            headers: { "content-type": "text/x-component" },
          }),
      ),
    );

    expect(result).not.toBeNull();
    // Flight response should NOT have X-RSC-Redirect: "soft" from the original
    expect(result!.headers.get("X-RSC-Redirect")).toBeNull();
    // Other custom headers should still be carried over
    expect(result!.headers.get("X-Custom")).toBe("keep-me");
    // Location should not be carried over
    expect(result!.headers.get("Location")).toBeNull();
  });

  it("does not overwrite headers already on the intercepted response", () => {
    const ctx = createRequestContext({
      env: {},
      request: new Request("https://example.com"),
      url: new URL("https://example.com"),
      variables: {},
    });

    const response = new Response(null, {
      status: 302,
      headers: {
        Location: "/target",
        "content-type": "text/html",
      },
    });

    const result = runWithRequestContext(ctx, () =>
      interceptRedirectForPartial(
        response,
        (url) => new Response(`flight:${url}`),
      ),
    );

    expect(result).not.toBeNull();
    expect(result!.headers.get("X-RSC-Redirect")).toBe("/target");
  });

  it("routes an external-marked redirect through the Flight path with external=true", () => {
    const ctx = createRequestContext({
      env: {},
      request: new Request("https://example.com"),
      url: new URL("https://example.com"),
      variables: {},
    });

    // redirect(url, { external: true }) stamps the internal marker.
    const response = new Response(null, {
      status: 302,
      headers: {
        Location: "https://accounts.example.com/oauth",
        [EXTERNAL_REDIRECT_MARKER]: "1",
      },
    });

    let captured: { url: string; external?: boolean } | undefined;
    const result = runWithRequestContext(ctx, () =>
      interceptRedirectForPartial(response, (url, _state, external) => {
        captured = { url, external };
        return new Response(`flight:${url}`, {
          headers: { "content-type": "text/x-component" },
        });
      }),
    );

    expect(result).not.toBeNull();
    // External redirects must take the Flight payload path (so the client does
    // a hard navigation), NOT the X-RSC-Redirect simple path.
    expect(captured).toEqual({
      url: "https://accounts.example.com/oauth",
      external: true,
    });
    // The internal marker is consumed here and never carried to the client.
    expect(result!.headers.get(EXTERNAL_REDIRECT_MARKER)).toBeNull();
  });

  it("uses the simple X-RSC-Redirect path (no Flight factory) for a normal redirect", () => {
    const ctx = createRequestContext({
      env: {},
      request: new Request("https://example.com"),
      url: new URL("https://example.com"),
      variables: {},
    });

    const response = new Response(null, {
      status: 302,
      headers: { Location: "/dashboard" },
    });

    let factoryCalled = false;
    const result = runWithRequestContext(ctx, () =>
      interceptRedirectForPartial(response, (url) => {
        factoryCalled = true;
        return new Response(`flight:${url}`);
      }),
    );

    // No location state and no external marker -> simple path; the Flight
    // factory is never invoked.
    expect(factoryCalled).toBe(false);
    expect(result!.headers.get("X-RSC-Redirect")).toBe("/dashboard");
  });
});

describe("carryOverRedirectHeaders", () => {
  it("copies Set-Cookie from source to target via append", () => {
    const headers = new Headers();
    headers.set("Location", "/login");
    headers.append("Set-Cookie", "flash=1; Path=/");
    headers.append("Set-Cookie", "session=abc; Path=/; HttpOnly");
    const source = new Response(null, { status: 302, headers });
    const target = new Response(null, { status: 204 });

    carryOverRedirectHeaders(source, target);

    const cookies = target.headers.getSetCookie();
    expect(cookies).toContain("flash=1; Path=/");
    expect(cookies).toContain("session=abc; Path=/; HttpOnly");
  });

  it("copies custom headers from source", () => {
    const source = new Response(null, {
      status: 302,
      headers: {
        Location: "/target",
        "X-Request-Id": "req-42",
        "X-Custom": "value",
      },
    });
    const target = new Response(null, { status: 204 });

    carryOverRedirectHeaders(source, target);

    expect(target.headers.get("X-Request-Id")).toBe("req-42");
    expect(target.headers.get("X-Custom")).toBe("value");
  });

  it("skips Location and X-RSC-Redirect", () => {
    const source = new Response(null, {
      status: 302,
      headers: {
        Location: "/original",
        "X-RSC-Redirect": "soft",
        "X-Keep": "yes",
      },
    });
    const target = new Response(null, {
      status: 204,
      headers: { "X-RSC-Redirect": "/new-target" },
    });

    carryOverRedirectHeaders(source, target);

    expect(target.headers.get("Location")).toBeNull();
    expect(target.headers.get("X-RSC-Redirect")).toBe("/new-target");
    expect(target.headers.get("X-Keep")).toBe("yes");
  });

  it("preserves the external-redirect marker (generic copier; exits strip it)", () => {
    // carryOverRedirectHeaders is shared by document-native rebuilds
    // (extractRedirectResponse) that MUST carry the marker through to the guard
    // chokepoint. Stripping it here would silently defeat external redirects on
    // the PE/no-JS channel. The two browser-facing exits (guardOutgoingRedirect
    // and interceptRedirectForPartial) strip it instead.
    const source = new Response(null, {
      status: 302,
      headers: {
        Location: "https://accounts.example.com/oauth",
        [EXTERNAL_REDIRECT_MARKER]: "1",
        "X-Keep": "yes",
      },
    });
    const target = new Response(null, { status: 302 });

    carryOverRedirectHeaders(source, target);

    expect(target.headers.get(EXTERNAL_REDIRECT_MARKER)).toBe("1");
    expect(target.headers.get("X-Keep")).toBe("yes");
  });

  it("does not overwrite existing headers on target", () => {
    const source = new Response(null, {
      status: 302,
      headers: { "content-type": "text/html", "X-Source": "original" },
    });
    const target = new Response(null, {
      status: 204,
      headers: { "content-type": "text/x-component" },
    });

    carryOverRedirectHeaders(source, target);

    expect(target.headers.get("content-type")).toBe("text/x-component");
    expect(target.headers.get("X-Source")).toBe("original");
  });
});

describe("isWebSocketUpgradeResponse", () => {
  // Node's Response constructor rejects status outside 200–599 (RangeError),
  // so we fabricate an upgrade-style Response by overriding `.status` on a
  // real Response instance. This mirrors what workerd produces for a real WS
  // upgrade via `acceptWebSocket` / `handleWebSocketUpgrade` / the `agents`
  // library's `routeAgentRequest`.
  const fabricate = (opts: { status101?: boolean; webSocket?: unknown }) => {
    const response = new Response(null, { status: 200 });
    if (opts.status101) {
      Object.defineProperty(response, "status", {
        value: 101,
        configurable: true,
      });
    }
    if (opts.webSocket !== undefined) {
      Object.defineProperty(response, "webSocket", {
        value: opts.webSocket,
        configurable: true,
        enumerable: true,
        writable: true,
      });
    }
    return response;
  };

  it("returns true for status 101", () => {
    const response = fabricate({ status101: true });
    expect(isWebSocketUpgradeResponse(response)).toBe(true);
  });

  it("returns true when a webSocket property is attached (workerd pattern)", () => {
    // Status 200 + webSocket property — the workerd response shape where
    // we cannot rely on status alone because workerd relaxes the 200–599
    // range but consumers may not see the final 101 yet.
    const response = fabricate({ webSocket: { stub: "ws" } });
    expect(isWebSocketUpgradeResponse(response)).toBe(true);
  });

  it("returns true for both status 101 and webSocket property together", () => {
    const response = fabricate({ status101: true, webSocket: { stub: "ws" } });
    expect(isWebSocketUpgradeResponse(response)).toBe(true);
  });

  it("returns false for an ordinary 200 JSON response", () => {
    const response = new Response('{"ok":true}', {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    expect(isWebSocketUpgradeResponse(response)).toBe(false);
  });

  it("returns false for a streaming SSE-style 200 response (no webSocket property)", () => {
    // SSE uses text/event-stream + ReadableStream body + status 200 — it
    // must NOT be treated as an upgrade. This guards against a regression
    // where the check accidentally matches streaming bodies.
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: hello\n\n"));
        controller.close();
      },
    });
    const response = new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
    expect(isWebSocketUpgradeResponse(response)).toBe(false);
  });

  it("returns false for 3xx redirects", () => {
    const response = new Response(null, {
      status: 302,
      headers: { location: "/elsewhere" },
    });
    expect(isWebSocketUpgradeResponse(response)).toBe(false);
  });

  it("returns false for error responses (4xx, 5xx)", () => {
    expect(
      isWebSocketUpgradeResponse(new Response(null, { status: 404 })),
    ).toBe(false);
    expect(
      isWebSocketUpgradeResponse(new Response(null, { status: 500 })),
    ).toBe(false);
  });

  it("ignores a webSocket property explicitly set to null", () => {
    // `!= null` must exclude both undefined and null — avoid a false-positive
    // when some library sets `response.webSocket = null` as a sentinel.
    const response = fabricate({ webSocket: null });
    expect(isWebSocketUpgradeResponse(response)).toBe(false);
  });
});
