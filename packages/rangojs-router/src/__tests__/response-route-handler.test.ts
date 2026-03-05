import { describe, expect, it, vi } from "vitest";

// Mock cache-scope to avoid virtual module chain
vi.mock("../cache/cache-scope.js", () => ({
  createCacheScope: vi.fn(() => null),
}));

import {
  createRequestContext,
  runWithRequestContext,
} from "../server/request-context.js";
import { handleResponseRoute } from "../rsc/response-route-handler.js";
import type { HandlerContext } from "../rsc/handler-context.js";
import type { ResponseRouteMatch } from "../rsc/response-route-handler.js";

function createMockHandlerCtx(
  routeMap: Record<string, string> = {},
): HandlerContext<unknown> {
  return {
    router: {} as any,
    version: "test",
    renderToReadableStream: vi.fn() as any,
    decodeReply: vi.fn() as any,
    createTemporaryReferenceSet: vi.fn() as any,
    loadServerAction: vi.fn() as any,
    decodeAction: vi.fn() as any,
    decodeFormState: vi.fn() as any,
    loadSSRModule: vi.fn() as any,
    callOnError: vi.fn(),
    getRequiredRouteMap: () => routeMap,
    createRedirectFlightResponse: vi.fn() as any,
  };
}

function createTestEnv() {
  return {
    env: {},
    request: new Request("https://example.com/api/data"),
    url: new URL("https://example.com/api/data"),
    variables: {},
  };
}

describe("response-route-handler", () => {
  describe("ctx.reverse is available (not href)", () => {
    it("provides reverse function from route map", async () => {
      const routeMap = { "api.users": "/api/users/:id" };
      const handlerCtx = createMockHandlerCtx(routeMap);
      const testEnv = createTestEnv();
      const ctx = createRequestContext(testEnv);

      let capturedCtx: any;
      const preview: ResponseRouteMatch = {
        responseType: "json",
        handler: (handlerContext: any) => {
          capturedCtx = handlerContext;
          return { ok: true };
        },
        params: {},
      };

      await runWithRequestContext(ctx, () =>
        handleResponseRoute(
          handlerCtx,
          preview,
          testEnv.request,
          testEnv.env,
          testEnv.url,
          testEnv.variables,
        ),
      );

      expect(capturedCtx.reverse).toBeTypeOf("function");
      expect(capturedCtx.reverse("api.users", { id: "42" })).toBe(
        "/api/users/42",
      );
      // href should NOT exist
      expect(capturedCtx.href).toBeUndefined();
    });
  });

  describe("internal params are stripped from handler context", () => {
    it("filters _rsc* params from searchParams and url", async () => {
      const handlerCtx = createMockHandlerCtx();
      // URL with internal params (but no _rsc_partial to avoid partial early return)
      const url = new URL("https://example.com/api/data?_rsc_v=1&q=hello");
      const request = new Request(url);
      const testEnv = { env: {}, request, url, variables: {} };
      const ctx = createRequestContext(testEnv);

      let capturedCtx: any;
      const preview: ResponseRouteMatch = {
        responseType: "json",
        handler: (handlerContext: any) => {
          capturedCtx = handlerContext;
          return { ok: true };
        },
        params: {},
      };

      await runWithRequestContext(ctx, () =>
        handleResponseRoute(handlerCtx, preview, request, {}, url, {}),
      );

      // User param preserved
      expect(capturedCtx.searchParams.get("q")).toBe("hello");
      // Internal param stripped
      expect(capturedCtx.searchParams.has("_rsc_v")).toBe(false);
      expect(capturedCtx.url.searchParams.has("_rsc_v")).toBe(false);
    });
  });

  describe("rewrapResponse preserves duplicate Set-Cookie headers", () => {
    it("does not collapse multiple Set-Cookie entries", async () => {
      const handlerCtx = createMockHandlerCtx();
      const testEnv = createTestEnv();
      const ctx = createRequestContext(testEnv);

      const preview: ResponseRouteMatch = {
        responseType: "json",
        handler: () => {
          const headers = new Headers();
          headers.append("Set-Cookie", "a=1; Path=/");
          headers.append("Set-Cookie", "b=2; Path=/");
          headers.set("X-Custom", "yes");
          return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers,
          });
        },
        params: {},
      };

      const response = await runWithRequestContext(ctx, () =>
        handleResponseRoute(
          handlerCtx,
          preview,
          testEnv.request,
          testEnv.env,
          testEnv.url,
          testEnv.variables,
        ),
      );

      const cookies = response.headers.getSetCookie();
      expect(cookies.length).toBeGreaterThanOrEqual(2);
      expect(cookies).toContain("a=1; Path=/");
      expect(cookies).toContain("b=2; Path=/");
      expect(response.headers.get("X-Custom")).toBe("yes");
    });
  });

  describe("onResponse callbacks run on uncached response routes", () => {
    it("fires onResponse callback for uncached response route", async () => {
      const handlerCtx = createMockHandlerCtx();
      const testEnv = createTestEnv();
      const ctx = createRequestContext(testEnv);

      let callbackFired = false;
      ctx.onResponse((res) => {
        callbackFired = true;
        res.headers.set("X-Callback-Ran", "true");
        return res;
      });

      const preview: ResponseRouteMatch = {
        responseType: "json",
        handler: () => ({ data: "test" }),
        params: {},
      };

      const response = await runWithRequestContext(ctx, () =>
        handleResponseRoute(
          handlerCtx,
          preview,
          testEnv.request,
          testEnv.env,
          testEnv.url,
          testEnv.variables,
        ),
      );

      expect(callbackFired).toBe(true);
      expect(response.headers.get("X-Callback-Ran")).toBe("true");
    });
  });

  describe("partial request returns X-RSC-Reload", () => {
    it("returns reload header with internal params stripped", async () => {
      const handlerCtx = createMockHandlerCtx();
      const url = new URL(
        "https://example.com/api/data?_rsc_partial=true&_rsc_segments=root",
      );
      const request = new Request(url);
      const testEnv = { env: {}, request, url, variables: {} };
      const ctx = createRequestContext(testEnv);

      const preview: ResponseRouteMatch = {
        responseType: "json",
        handler: vi.fn(),
        params: {},
      };

      const response = await runWithRequestContext(ctx, () =>
        handleResponseRoute(handlerCtx, preview, request, {}, url, {}),
      );

      expect(response.status).toBe(200);
      const reloadUrl = response.headers.get("X-RSC-Reload");
      expect(reloadUrl).toBeDefined();
      // Internal params should be stripped from the reload URL
      expect(reloadUrl).not.toContain("_rsc_partial");
      expect(reloadUrl).not.toContain("_rsc_segments");
      // Handler should not have been called
      expect(preview.handler).not.toHaveBeenCalled();
    });
  });
});
