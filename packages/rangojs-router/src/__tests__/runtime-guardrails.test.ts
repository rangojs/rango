import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  warnActionWithRouteMiddleware,
  _resetW1Warnings,
  extractRedirectResponse,
  warnNonRedirectPeResponse,
} from "../rsc/runtime-warnings.js";

describe("W1: route middleware is not action guard", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    _resetW1Warnings();
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("warns when action fires on a route with middleware", () => {
    warnActionWithRouteMiddleware("action_abc123", "shop.cart");
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0]![0]).toContain(
      "Route middleware does not guard server actions",
    );
    expect(warnSpy.mock.calls[0]![0]).toContain("action_abc123");
  });

  it("deduplicates by route key", () => {
    warnActionWithRouteMiddleware("action_1", "shop.cart");
    warnActionWithRouteMiddleware("action_2", "shop.cart");
    expect(warnSpy).toHaveBeenCalledOnce();
  });

  it("warns separately for different route keys", () => {
    warnActionWithRouteMiddleware("action_1", "shop.cart");
    warnActionWithRouteMiddleware("action_2", "blog.comment");
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });

  it("handles undefined route key", () => {
    warnActionWithRouteMiddleware("action_1", undefined);
    expect(warnSpy).toHaveBeenCalledOnce();
    warnActionWithRouteMiddleware("action_2", undefined);
    expect(warnSpy).toHaveBeenCalledOnce();
  });
});

describe("W3: PE action redirect handling", () => {
  it("extracts redirect from a 302 Response", () => {
    const response = new Response(null, {
      status: 302,
      headers: { Location: "/dashboard" },
    });
    const result = extractRedirectResponse(response);
    expect(result).toBeInstanceOf(Response);
    expect(result!.status).toBe(302);
    expect(result!.headers.get("Location")).toBe("/dashboard");
  });

  it("extracts redirect from a 301 Response", () => {
    const result = extractRedirectResponse(
      new Response(null, {
        status: 301,
        headers: { Location: "/new-path" },
      }),
    );
    expect(result).toBeInstanceOf(Response);
    expect(result!.status).toBe(301);
  });

  it("returns null for non-redirect Response", () => {
    const result = extractRedirectResponse(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    expect(result).toBeNull();
  });

  it("returns null for Response without Location header", () => {
    const result = extractRedirectResponse(new Response(null, { status: 302 }));
    expect(result).toBeNull();
  });

  it("returns null for non-Response values", () => {
    expect(extractRedirectResponse("string")).toBeNull();
    expect(extractRedirectResponse(42)).toBeNull();
    expect(extractRedirectResponse(null)).toBeNull();
    expect(extractRedirectResponse(new Error("boom"))).toBeNull();
    expect(extractRedirectResponse({ status: 302 })).toBeNull();
  });

  it("preserves Set-Cookie and custom headers from original redirect", () => {
    const headers = new Headers();
    headers.set("Location", "/login");
    headers.append("Set-Cookie", "flash=done; Path=/");
    headers.append("Set-Cookie", "token=xyz; Path=/; HttpOnly");
    headers.set("X-Request-Id", "req-99");
    const response = new Response(null, { status: 302, headers });

    const result = extractRedirectResponse(response);
    expect(result).toBeInstanceOf(Response);

    const cookies = result!.headers.getSetCookie();
    expect(cookies).toContain("flash=done; Path=/");
    expect(cookies).toContain("token=xyz; Path=/; HttpOnly");
    expect(result!.headers.get("X-Request-Id")).toBe("req-99");
    // Location is on the wrapper, not carried over from source
    expect(result!.headers.get("Location")).toBe("/login");
  });
});

describe("W3: PE non-redirect Response warning", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("warns about non-redirect Response in PE mode", () => {
    warnNonRedirectPeResponse();
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0]![0]).toContain("progressive enhancement");
  });
});
