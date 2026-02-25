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
