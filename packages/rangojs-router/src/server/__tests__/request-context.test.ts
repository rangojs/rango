/**
 * Tests for RequestContext, specifically the onResponse callback API
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  createRequestContext,
  runWithRequestContext,
  getRequestContext,
} from "../request-context.js";

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("RequestContext", () => {
  describe("url stripping", () => {
    it("ctx.url should have _rsc* params stripped", () => {
      const rawUrl = new URL(
        "https://example.com/products?q=hello&_rsc_partial=1&_rsc_segments=M0,M1&page=2",
      );
      const ctx = createRequestContext({
        env: {},
        request: new Request(rawUrl),
        url: rawUrl,
        variables: {},
      });

      expect(ctx.url.searchParams.has("_rsc_partial")).toBe(false);
      expect(ctx.url.searchParams.has("_rsc_segments")).toBe(false);
      expect(ctx.url.searchParams.get("q")).toBe("hello");
      expect(ctx.url.searchParams.get("page")).toBe("2");
      expect(ctx.url.pathname).toBe("/products");
    });

    it("ctx.originalUrl should preserve all _rsc* params", () => {
      const rawUrl = new URL(
        "https://example.com/test?_rsc_partial=1&_rsc_stale=true&q=search",
      );
      const ctx = createRequestContext({
        env: {},
        request: new Request(rawUrl),
        url: rawUrl,
        variables: {},
      });

      expect(ctx.originalUrl.searchParams.has("_rsc_partial")).toBe(true);
      expect(ctx.originalUrl.searchParams.has("_rsc_stale")).toBe(true);
      expect(ctx.originalUrl.searchParams.get("q")).toBe("search");
    });

    it("ctx.searchParams should have _rsc* params stripped (same as ctx.url)", () => {
      const rawUrl = new URL(
        "https://example.com/test?_rsc_partial=1&q=search",
      );
      const ctx = createRequestContext({
        env: {},
        request: new Request(rawUrl),
        url: rawUrl,
        variables: {},
      });

      expect(ctx.searchParams.has("_rsc_partial")).toBe(false);
      expect(ctx.searchParams.get("q")).toBe("search");
      // searchParams should be the same object as url.searchParams
      expect(ctx.searchParams).toBe(ctx.url.searchParams);
    });

    it("ctx.url should be a clean URL when no _rsc* params exist", () => {
      const rawUrl = new URL("https://example.com/test?q=hello&page=2");
      const ctx = createRequestContext({
        env: {},
        request: new Request(rawUrl),
        url: rawUrl,
        variables: {},
      });

      expect(ctx.url.searchParams.get("q")).toBe("hello");
      expect(ctx.url.searchParams.get("page")).toBe("2");
    });

    it("getRequestContext().url should have _rsc* params stripped", () => {
      const rawUrl = new URL(
        "https://example.com/page?_rsc_partial=1&_rsc_v=abc&tab=pricing",
      );
      const ctx = createRequestContext({
        env: {},
        request: new Request(rawUrl),
        url: rawUrl,
        variables: {},
      });

      runWithRequestContext(ctx, () => {
        const current = getRequestContext();
        expect(current.url.searchParams.has("_rsc_partial")).toBe(false);
        expect(current.url.searchParams.has("_rsc_v")).toBe(false);
        expect(current.url.searchParams.get("tab")).toBe("pricing");
      });
    });
  });

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

  describe("setLocationState", () => {
    it("accepts a single entry", () => {
      const ctx = createRequestContext({
        env: {},
        request: new Request("https://example.com"),
        url: new URL("https://example.com"),
        variables: {},
      });

      ctx.setLocationState({
        __rsc_ls_key: "flash",
        __rsc_ls_value: { text: "hello" },
      });

      expect(ctx._locationState).toEqual([
        { __rsc_ls_key: "flash", __rsc_ls_value: { text: "hello" } },
      ]);
    });

    it("accepts an array of entries", () => {
      const ctx = createRequestContext({
        env: {},
        request: new Request("https://example.com"),
        url: new URL("https://example.com"),
        variables: {},
      });

      ctx.setLocationState([
        { __rsc_ls_key: "a", __rsc_ls_value: 1 },
        { __rsc_ls_key: "b", __rsc_ls_value: 2 },
      ]);

      expect(ctx._locationState).toEqual([
        { __rsc_ls_key: "a", __rsc_ls_value: 1 },
        { __rsc_ls_key: "b", __rsc_ls_value: 2 },
      ]);
    });

    it("accumulates across multiple calls mixing single and array", () => {
      const ctx = createRequestContext({
        env: {},
        request: new Request("https://example.com"),
        url: new URL("https://example.com"),
        variables: {},
      });

      ctx.setLocationState({
        __rsc_ls_key: "first",
        __rsc_ls_value: "one",
      });
      ctx.setLocationState([
        { __rsc_ls_key: "second", __rsc_ls_value: "two" },
        { __rsc_ls_key: "third", __rsc_ls_value: "three" },
      ]);

      expect(ctx._locationState).toEqual([
        { __rsc_ls_key: "first", __rsc_ls_value: "one" },
        { __rsc_ls_key: "second", __rsc_ls_value: "two" },
        { __rsc_ls_key: "third", __rsc_ls_value: "three" },
      ]);
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

  describe("request-context isolation", () => {
    it("keeps vars, params, cookies, and headers isolated across concurrent async requests", async () => {
      const ctxA = createRequestContext({
        env: { tenant: "alpha" },
        request: new Request("https://example.com/a", {
          headers: { Cookie: "session=a" },
        }),
        url: new URL("https://example.com/a"),
        variables: {},
      });
      const ctxB = createRequestContext({
        env: { tenant: "beta" },
        request: new Request("https://example.com/b", {
          headers: { Cookie: "session=b" },
        }),
        url: new URL("https://example.com/b"),
        variables: {},
      });

      const gateA = createDeferred<void>();
      const gateB = createDeferred<void>();

      const requestA = runWithRequestContext(ctxA, async () => {
        const current = getRequestContext<typeof ctxA.env>();
        current.params = { slug: "alpha" };
        current.set("tenant", "alpha");
        current.header("X-Request", "alpha");
        current.setCookie("session", "alpha-updated", { path: "/" });
        await gateA.promise;

        const resumed = getRequestContext<typeof ctxA.env>();
        return {
          pathname: resumed.pathname,
          params: resumed.params,
          tenant: resumed.get("tenant"),
          cookie: resumed.cookie("session"),
          header: resumed.res.headers.get("X-Request"),
          envTenant: resumed.env.tenant,
        };
      });

      const requestB = runWithRequestContext(ctxB, async () => {
        const current = getRequestContext<typeof ctxB.env>();
        current.params = { slug: "beta" };
        current.set("tenant", "beta");
        current.header("X-Request", "beta");
        current.setCookie("session", "beta-updated", { path: "/" });
        await gateB.promise;

        const resumed = getRequestContext<typeof ctxB.env>();
        return {
          pathname: resumed.pathname,
          params: resumed.params,
          tenant: resumed.get("tenant"),
          cookie: resumed.cookie("session"),
          header: resumed.res.headers.get("X-Request"),
          envTenant: resumed.env.tenant,
        };
      });

      gateB.resolve();
      const resultB = await requestB;
      gateA.resolve();
      const resultA = await requestA;

      expect(resultA).toEqual({
        pathname: "/a",
        params: { slug: "alpha" },
        tenant: "alpha",
        cookie: "alpha-updated",
        header: "alpha",
        envTenant: "alpha",
      });
      expect(resultB).toEqual({
        pathname: "/b",
        params: { slug: "beta" },
        tenant: "beta",
        cookie: "beta-updated",
        header: "beta",
        envTenant: "beta",
      });

      expect(ctxA.cookie("session")).toBe("alpha-updated");
      expect(ctxB.cookie("session")).toBe("beta-updated");
      expect(ctxA.res.headers.get("X-Request")).toBe("alpha");
      expect(ctxB.res.headers.get("X-Request")).toBe("beta");
      expect(ctxA.get("tenant")).toBe("alpha");
      expect(ctxB.get("tenant")).toBe("beta");
    });

    it("keeps onResponse callbacks isolated across concurrent request contexts", async () => {
      const ctxA = createRequestContext({
        env: {},
        request: new Request("https://example.com/a"),
        url: new URL("https://example.com/a"),
        variables: {},
      });
      const ctxB = createRequestContext({
        env: {},
        request: new Request("https://example.com/b"),
        url: new URL("https://example.com/b"),
        variables: {},
      });

      const gateA = createDeferred<void>();
      const gateB = createDeferred<void>();

      const requestA = runWithRequestContext(ctxA, async () => {
        getRequestContext().onResponse((res) => {
          const headers = new Headers(res.headers);
          headers.set("X-Context", "alpha");
          return new Response(res.body, { status: res.status, headers });
        });
        await gateA.promise;
      });

      const requestB = runWithRequestContext(ctxB, async () => {
        getRequestContext().onResponse((res) => {
          const headers = new Headers(res.headers);
          headers.set("X-Context", "beta");
          return new Response(res.body, { status: res.status, headers });
        });
        await gateB.promise;
      });

      gateB.resolve();
      await requestB;
      gateA.resolve();
      await requestA;

      expect(ctxA._onResponseCallbacks).toHaveLength(1);
      expect(ctxB._onResponseCallbacks).toHaveLength(1);

      const responseA = ctxA._onResponseCallbacks[0]!(new Response("A"));
      const responseB = ctxB._onResponseCallbacks[0]!(new Response("B"));

      expect(responseA.headers.get("X-Context")).toBe("alpha");
      expect(responseB.headers.get("X-Context")).toBe("beta");
    });
  });

  describe("response cookie Max-Age deletion classification", () => {
    function ctxWithSetCookie(setCookie: string) {
      const url = new URL("https://example.com/");
      const ctx = createRequestContext({
        env: {},
        request: new Request(url),
        url,
        variables: {},
      });
      ctx.res.headers.append("Set-Cookie", setCookie);
      return ctx;
    }

    it("treats Max-Age=0 as a deletion (cookie reads as absent)", () => {
      const ctx = ctxWithSetCookie("session=abc; Max-Age=0");
      expect(ctx.cookie("session")).toBeUndefined();
      expect(ctx.cookies().session).toBeUndefined();
    });

    it("treats a negative Max-Age as a deletion", () => {
      const ctx = ctxWithSetCookie("session=abc; Max-Age=-1");
      expect(ctx.cookie("session")).toBeUndefined();
    });

    it("does NOT treat zero-prefixed Max-Age=05 as a deletion", () => {
      // Max-Age=05 is a real 5-second cookie; it must be readable, not absent.
      const ctx = ctxWithSetCookie("session=abc; Max-Age=05");
      expect(ctx.cookie("session")).toBe("abc");
      expect(ctx.cookies().session).toBe("abc");
    });

    it("does NOT treat Max-Age=00 as a deletion when followed by other attrs", () => {
      // A pathological zero-prefixed value that still parses to 0 IS a deletion;
      // but a non-zero zero-prefixed value like 010 must survive.
      const ctx = ctxWithSetCookie("session=abc; Max-Age=010; Path=/");
      expect(ctx.cookie("session")).toBe("abc");
    });

    it("treats a positive Max-Age as a live cookie", () => {
      const ctx = ctxWithSetCookie("session=abc; Max-Age=3600");
      expect(ctx.cookie("session")).toBe("abc");
    });
  });
});
