/**
 * Tests for RequestContext, specifically the onResponse callback API
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  createRequestContext,
  runWithRequestContext,
  getRequestContext,
} from "../request-context.js";

describe("RequestContext", () => {
  describe("cookie parsing", () => {
    it("should parse normal cookies correctly", () => {
      const ctx = createRequestContext({
        env: {},
        request: new Request("https://example.com", {
          headers: { Cookie: "session=abc123; lang=en" },
        }),
        url: new URL("https://example.com"),
        variables: {},
      });

      expect(ctx.cookie("session")).toBe("abc123");
      expect(ctx.cookie("lang")).toBe("en");
    });

    it("should decode percent-encoded cookie values", () => {
      const ctx = createRequestContext({
        env: {},
        request: new Request("https://example.com", {
          headers: { Cookie: "name=hello%20world" },
        }),
        url: new URL("https://example.com"),
        variables: {},
      });

      expect(ctx.cookie("name")).toBe("hello world");
    });

    it("should fall back to raw value for malformed percent encoding (%zz)", () => {
      const ctx = createRequestContext({
        env: {},
        request: new Request("https://example.com", {
          headers: { Cookie: "bad=%zz" },
        }),
        url: new URL("https://example.com"),
        variables: {},
      });

      expect(ctx.cookie("bad")).toBe("%zz");
    });

    it("should fall back to raw value for truncated percent encoding (%2)", () => {
      const ctx = createRequestContext({
        env: {},
        request: new Request("https://example.com", {
          headers: { Cookie: "trunc=%2" },
        }),
        url: new URL("https://example.com"),
        variables: {},
      });

      expect(ctx.cookie("trunc")).toBe("%2");
    });

    it("should parse valid cookies alongside malformed ones", () => {
      const ctx = createRequestContext({
        env: {},
        request: new Request("https://example.com", {
          headers: { Cookie: "good=hello%20world; bad=%zz; also_good=ok" },
        }),
        url: new URL("https://example.com"),
        variables: {},
      });

      expect(ctx.cookie("good")).toBe("hello world");
      expect(ctx.cookie("bad")).toBe("%zz");
      expect(ctx.cookie("also_good")).toBe("ok");
    });
  });

  describe("cookie read-after-write (response-derived)", () => {
    it("setCookie makes cookie() return the new value", () => {
      const ctx = createRequestContext({
        env: {},
        request: new Request("https://example.com", {
          headers: { Cookie: "token=old" },
        }),
        url: new URL("https://example.com"),
        variables: {},
      });

      expect(ctx.cookie("token")).toBe("old");
      ctx.setCookie("token", "new");
      expect(ctx.cookie("token")).toBe("new");
    });

    it("setCookie makes cookies() include the new value", () => {
      const ctx = createRequestContext({
        env: {},
        request: new Request("https://example.com", {
          headers: { Cookie: "a=1; b=2" },
        }),
        url: new URL("https://example.com"),
        variables: {},
      });

      ctx.setCookie("c", "3");
      const all = ctx.cookies();
      expect(all).toEqual({ a: "1", b: "2", c: "3" });
    });

    it("setCookie overwrites a header cookie in cookies()", () => {
      const ctx = createRequestContext({
        env: {},
        request: new Request("https://example.com", {
          headers: { Cookie: "session=abc" },
        }),
        url: new URL("https://example.com"),
        variables: {},
      });

      ctx.setCookie("session", "xyz");
      expect(ctx.cookies()).toEqual({ session: "xyz" });
    });

    it("deleteCookie makes cookie() return undefined", () => {
      const ctx = createRequestContext({
        env: {},
        request: new Request("https://example.com", {
          headers: { Cookie: "session=abc" },
        }),
        url: new URL("https://example.com"),
        variables: {},
      });

      expect(ctx.cookie("session")).toBe("abc");
      ctx.deleteCookie("session");
      expect(ctx.cookie("session")).toBeUndefined();
    });

    it("deleteCookie removes the key from cookies()", () => {
      const ctx = createRequestContext({
        env: {},
        request: new Request("https://example.com", {
          headers: { Cookie: "a=1; b=2" },
        }),
        url: new URL("https://example.com"),
        variables: {},
      });

      ctx.deleteCookie("a");
      expect(ctx.cookies()).toEqual({ b: "2" });
    });

    it("last-write-wins: multiple setCookie calls for same name", () => {
      const ctx = createRequestContext({
        env: {},
        request: new Request("https://example.com"),
        url: new URL("https://example.com"),
        variables: {},
      });

      ctx.setCookie("x", "first");
      ctx.setCookie("x", "second");
      ctx.setCookie("x", "third");
      expect(ctx.cookie("x")).toBe("third");
    });

    it("setCookie for unknown cookie then deleteCookie makes it undefined", () => {
      const ctx = createRequestContext({
        env: {},
        request: new Request("https://example.com"),
        url: new URL("https://example.com"),
        variables: {},
      });

      ctx.setCookie("temp", "value");
      expect(ctx.cookie("temp")).toBe("value");
      ctx.deleteCookie("temp");
      expect(ctx.cookie("temp")).toBeUndefined();
    });

    it("cookies() returns a fresh copy each time, not the overlay itself", () => {
      const ctx = createRequestContext({
        env: {},
        request: new Request("https://example.com", {
          headers: { Cookie: "a=1" },
        }),
        url: new URL("https://example.com"),
        variables: {},
      });

      const snap1 = ctx.cookies();
      ctx.setCookie("b", "2");
      const snap2 = ctx.cookies();

      expect(snap1).toEqual({ a: "1" });
      expect(snap2).toEqual({ a: "1", b: "2" });
    });

    it("setCookie still appends Set-Cookie to stub response", () => {
      const ctx = createRequestContext({
        env: {},
        request: new Request("https://example.com"),
        url: new URL("https://example.com"),
        variables: {},
      });

      ctx.setCookie("token", "abc", { httpOnly: true, path: "/" });
      const setCookieHeaders = ctx.res.headers.getSetCookie();
      expect(setCookieHeaders.length).toBe(1);
      expect(setCookieHeaders[0]).toContain("token=abc");
      expect(setCookieHeaders[0]).toContain("HttpOnly");
    });

    it("cookie mutations visible across request context via runWithRequestContext", () => {
      const ctx = createRequestContext({
        env: {},
        request: new Request("https://example.com"),
        url: new URL("https://example.com"),
        variables: {},
      });

      runWithRequestContext(ctx, () => {
        const inner = getRequestContext();
        inner.setCookie("shared", "value");
        expect(ctx.cookie("shared")).toBe("value");
      });
    });
  });

  describe("setStatus", () => {
    it("changes res.status", () => {
      const ctx = createRequestContext({
        env: {},
        request: new Request("https://example.com"),
        url: new URL("https://example.com"),
        variables: {},
      });

      expect(ctx.res.status).toBe(200);
      ctx.setStatus(404);
      expect(ctx.res.status).toBe(404);
    });

    it("preserves existing headers after setStatus", () => {
      const ctx = createRequestContext({
        env: {},
        request: new Request("https://example.com"),
        url: new URL("https://example.com"),
        variables: {},
      });

      ctx.header("X-Custom", "value");
      ctx.setCookie("token", "abc");
      ctx.setStatus(500);

      expect(ctx.res.status).toBe(500);
      expect(ctx.res.headers.get("X-Custom")).toBe("value");
      expect(ctx.res.headers.getSetCookie()).toEqual(
        expect.arrayContaining([expect.stringContaining("token=abc")]),
      );
    });

    it("cookies set before setStatus are still readable", () => {
      const ctx = createRequestContext({
        env: {},
        request: new Request("https://example.com"),
        url: new URL("https://example.com"),
        variables: {},
      });

      ctx.setCookie("before", "status-change");
      ctx.setStatus(404);
      expect(ctx.cookie("before")).toBe("status-change");
    });
  });

  describe("ctx.res read-only guard", () => {
    it("throws when attempting to assign ctx.res", () => {
      const ctx = createRequestContext({
        env: {},
        request: new Request("https://example.com"),
        url: new URL("https://example.com"),
        variables: {},
      });

      expect(() => {
        (ctx as any).res = new Response(null, { status: 500 });
      }).toThrow("ctx.res is read-only");
    });
  });

  describe("onResponse", () => {
    it("should register callbacks", () => {
      const ctx = createRequestContext({
        env: {},
        request: new Request("https://example.com"),
        url: new URL("https://example.com"),
        variables: {},
      });

      expect(ctx._onResponseCallbacks).toHaveLength(0);

      ctx.onResponse((res) => res);
      expect(ctx._onResponseCallbacks).toHaveLength(1);

      ctx.onResponse((res) => res);
      expect(ctx._onResponseCallbacks).toHaveLength(2);
    });

    it("should allow callbacks to inspect response status", () => {
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

      // Simulate calling the callback
      const response = new Response("OK", { status: 200 });
      for (const callback of ctx._onResponseCallbacks) {
        callback(response);
      }

      expect(capturedStatus).toBe(200);
    });

    it("should allow callbacks to modify response", () => {
      const ctx = createRequestContext({
        env: {},
        request: new Request("https://example.com"),
        url: new URL("https://example.com"),
        variables: {},
      });

      ctx.onResponse((res) => {
        // Return a new response with added header
        const newHeaders = new Headers(res.headers);
        newHeaders.set("X-Modified", "true");
        return new Response(res.body, {
          status: res.status,
          headers: newHeaders,
        });
      });

      let response = new Response("OK", { status: 200 });
      for (const callback of ctx._onResponseCallbacks) {
        response = callback(response);
      }

      expect(response.headers.get("X-Modified")).toBe("true");
    });

    it("should run multiple callbacks in order", () => {
      const ctx = createRequestContext({
        env: {},
        request: new Request("https://example.com"),
        url: new URL("https://example.com"),
        variables: {},
      });

      const order: number[] = [];

      ctx.onResponse((res) => {
        order.push(1);
        return res;
      });

      ctx.onResponse((res) => {
        order.push(2);
        return res;
      });

      ctx.onResponse((res) => {
        order.push(3);
        return res;
      });

      let response = new Response("OK");
      for (const callback of ctx._onResponseCallbacks) {
        response = callback(response) ?? response;
      }

      expect(order).toEqual([1, 2, 3]);
    });

    it("should allow callbacks to chain modifications", () => {
      const ctx = createRequestContext({
        env: {},
        request: new Request("https://example.com"),
        url: new URL("https://example.com"),
        variables: {},
      });

      ctx.onResponse((res) => {
        const newHeaders = new Headers(res.headers);
        newHeaders.set("X-First", "1");
        return new Response(res.body, {
          status: res.status,
          headers: newHeaders,
        });
      });

      ctx.onResponse((res) => {
        const newHeaders = new Headers(res.headers);
        newHeaders.set("X-Second", "2");
        return new Response(res.body, {
          status: res.status,
          headers: newHeaders,
        });
      });

      let response = new Response("OK");
      for (const callback of ctx._onResponseCallbacks) {
        response = callback(response) ?? response;
      }

      expect(response.headers.get("X-First")).toBe("1");
      expect(response.headers.get("X-Second")).toBe("2");
    });

    it("should be accessible via getRequestContext", () => {
      const ctx = createRequestContext({
        env: {},
        request: new Request("https://example.com"),
        url: new URL("https://example.com"),
        variables: {},
      });

      let callbackCalled = false;

      runWithRequestContext(ctx, () => {
        const currentCtx = getRequestContext();
        currentCtx?.onResponse((res) => {
          callbackCalled = true;
          return res;
        });
      });

      expect(ctx._onResponseCallbacks).toHaveLength(1);

      // Trigger callback
      const response = new Response("OK");
      for (const callback of ctx._onResponseCallbacks) {
        callback(response);
      }

      expect(callbackCalled).toBe(true);
    });
  });
});
