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
  finalizeResponse,
  interceptRedirectForPartial,
  carryOverRedirectHeaders,
} from "../helpers.js";

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
