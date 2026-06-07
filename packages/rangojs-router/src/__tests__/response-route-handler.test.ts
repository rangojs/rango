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
import { createCacheScope } from "../cache/cache-scope.js";
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
    resolveStreamMode: async () => "stream" as const,
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

  describe("rewrapResponse handles WebSocket upgrade responses", () => {
    it("preserves the webSocket property on WebSocket upgrade responses", async () => {
      const handlerCtx = createMockHandlerCtx();
      const testEnv = createTestEnv();
      const ctx = createRequestContext(testEnv);

      // Simulate a Cloudflare Workers WebSocket upgrade response.
      // Can't actually construct status 101 in Node (out of range), so use
      // the webSocket-property sentinel on a status-200 Response — the
      // short-circuit must still return the same object with the property
      // intact.
      const fakeSocket = { accept: () => {} };
      const original = new Response(null, { status: 200 });
      (original as unknown as { webSocket: unknown }).webSocket = fakeSocket;

      const preview: ResponseRouteMatch = {
        responseType: "any",
        handler: () => original,
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

      expect((response as unknown as { webSocket: unknown }).webSocket).toBe(
        fakeSocket,
      );
    });
  });

  describe("rewrapResponse honors ctx.setStatus() override on null-body responses", () => {
    it("applies setStatus(404) when handler returns 204", async () => {
      const handlerCtx = createMockHandlerCtx();
      const testEnv = createTestEnv();
      const ctx = createRequestContext(testEnv);

      const preview: ResponseRouteMatch = {
        responseType: "any",
        handler: () => {
          ctx.setStatus(404);
          return new Response(null, { status: 204 });
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

      expect(response.status).toBe(404);
    });
  });

  describe("problem+json status matches ctx.setStatus() override on a thrown error", () => {
    it("uses the overridden status in BOTH the HTTP response and the problem body", async () => {
      const handlerCtx = createMockHandlerCtx();
      const testEnv = createTestEnv();
      const ctx = createRequestContext(testEnv);

      const preview: ResponseRouteMatch = {
        responseType: "json",
        handler: () => {
          ctx.setStatus(400);
          throw new Error("boom");
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

      expect(response.status).toBe(400);
      expect(response.headers.get("content-type")).toBe(
        "application/problem+json;charset=utf-8",
      );
      const body = await response.json();
      // The problem body's status/title reflect the overridden 400 — not the
      // default 500 a plain Error's derived status would have produced.
      expect(body.status).toBe(400);
      expect(body.title).toBe("Bad Request");
      expect(body.detail).toBe("boom"); // dev (NODE_ENV=test) exposes the message
      expect(body.code).toBe("INTERNAL");
      expect(body.type).toBeUndefined();
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

  describe("response cache condition()", () => {
    function createMockStore() {
      return {
        get: vi.fn(),
        set: vi.fn(),
        getResponse: vi.fn(),
        putResponse: vi.fn(),
      };
    }

    function createMockCacheScope(
      condition: ((ctx: any) => boolean) | undefined,
      store: ReturnType<typeof createMockStore>,
    ) {
      return {
        enabled: true,
        config: {
          ttl: 60,
          condition,
        },
        ttl: 60,
        swr: 0,
        getStore: () => store,
      };
    }

    it("condition() === false skips cache read", async () => {
      const store = createMockStore();
      store.getResponse.mockResolvedValue({
        response: new Response(JSON.stringify({ data: "cached" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
        shouldRevalidate: false,
      });

      const scope = createMockCacheScope(() => false, store);
      vi.mocked(createCacheScope).mockReturnValue(scope as any);

      const handlerCtx = createMockHandlerCtx();
      const url = new URL("https://example.com/api/data");
      const request = new Request(url);
      const ctx = createRequestContext({
        env: {},
        request,
        url,
        variables: {},
      });

      const handler = vi.fn(() => "fresh");
      const preview: ResponseRouteMatch = {
        responseType: "json",
        handler,
        params: {},
        manifestEntry: { cache: { options: { ttl: 60 } }, parent: null } as any,
      };

      const response = await runWithRequestContext(ctx, () =>
        handleResponseRoute(handlerCtx, preview, request, {}, url, {}),
      );

      // store.getResponse should NOT be called — condition skipped cache
      expect(store.getResponse).not.toHaveBeenCalled();
      // Handler should have been called directly
      expect(handler).toHaveBeenCalled();
      const body = await response.json();
      expect(body).toBe("fresh");
    });

    it("condition() === false skips cache write", async () => {
      const store = createMockStore();
      const scope = createMockCacheScope(() => false, store);
      vi.mocked(createCacheScope).mockReturnValue(scope as any);

      const handlerCtx = createMockHandlerCtx();
      const url = new URL("https://example.com/api/data");
      const request = new Request(url);
      const waitUntilFns: Array<() => Promise<void>> = [];
      const ctx = createRequestContext({
        env: {},
        request,
        url,
        variables: {},
      });
      ctx.waitUntil = (fn) => {
        waitUntilFns.push(fn as any);
      };

      const preview: ResponseRouteMatch = {
        responseType: "json",
        handler: () => ({ data: "no-cache" }),
        params: {},
        manifestEntry: { cache: { options: { ttl: 60 } }, parent: null } as any,
      };

      await runWithRequestContext(ctx, () =>
        handleResponseRoute(handlerCtx, preview, request, {}, url, {}),
      );

      // Flush any waitUntil callbacks
      for (const fn of waitUntilFns) {
        await fn();
      }

      // store.putResponse should NOT be called — condition skipped cache
      expect(store.putResponse).not.toHaveBeenCalled();
    });

    it("condition() === true uses cache normally", async () => {
      const cachedResponse = new Response(
        JSON.stringify({ data: "cached-value" }),
        {
          status: 200,
          headers: { "content-type": "application/json;charset=utf-8" },
        },
      );

      const store = createMockStore();
      store.getResponse.mockResolvedValue({
        response: cachedResponse,
        shouldRevalidate: false,
      });

      const scope = createMockCacheScope(() => true, store);
      vi.mocked(createCacheScope).mockReturnValue(scope as any);

      const handlerCtx = createMockHandlerCtx();
      const url = new URL("https://example.com/api/data");
      const request = new Request(url);
      const ctx = createRequestContext({
        env: {},
        request,
        url,
        variables: {},
      });

      const handler = vi.fn(() => ({ data: "fresh" }));
      const preview: ResponseRouteMatch = {
        responseType: "json",
        handler,
        params: {},
        manifestEntry: { cache: { options: { ttl: 60 } }, parent: null } as any,
      };

      const response = await runWithRequestContext(ctx, () =>
        handleResponseRoute(handlerCtx, preview, request, {}, url, {}),
      );

      // store.getResponse SHOULD be called — condition passed
      expect(store.getResponse).toHaveBeenCalled();
      // Handler should NOT be called — cache hit
      expect(handler).not.toHaveBeenCalled();
      const body = await response.json();
      expect(body.data).toBe("cached-value");
    });
  });

  describe("response cache host isolation", () => {
    it("same path on different hosts uses different cache keys", async () => {
      const store = {
        get: vi.fn(),
        set: vi.fn(),
        getResponse: vi.fn().mockResolvedValue(null),
        putResponse: vi.fn(),
      };

      const scope = {
        enabled: true,
        config: { ttl: 60 },
        ttl: 60,
        swr: 0,
        getStore: () => store,
      };
      vi.mocked(createCacheScope).mockReturnValue(scope as any);

      const handlerCtx = createMockHandlerCtx();
      const cacheKeys: string[] = [];
      store.putResponse.mockImplementation((key: string) => {
        cacheKeys.push(key);
      });

      // Request from host A
      const urlA = new URL("https://app.example.com/api/data");
      const requestA = new Request(urlA);
      const ctxA = createRequestContext({
        env: {},
        request: requestA,
        url: urlA,
        variables: {},
      });
      ctxA.waitUntil = (fn) => (fn as any)();

      await runWithRequestContext(ctxA, () =>
        handleResponseRoute(
          handlerCtx,
          {
            responseType: "json",
            handler: () => ({ from: "hostA" }),
            params: {},
            manifestEntry: {
              cache: { options: { ttl: 60 } },
              parent: null,
            } as any,
          },
          requestA,
          {},
          urlA,
          {},
        ),
      );

      // Request from host B
      const urlB = new URL("https://staging.example.com/api/data");
      const requestB = new Request(urlB);
      const ctxB = createRequestContext({
        env: {},
        request: requestB,
        url: urlB,
        variables: {},
      });
      ctxB.waitUntil = (fn) => (fn as any)();

      await runWithRequestContext(ctxB, () =>
        handleResponseRoute(
          handlerCtx,
          {
            responseType: "json",
            handler: () => ({ from: "hostB" }),
            params: {},
            manifestEntry: {
              cache: { options: { ttl: 60 } },
              parent: null,
            } as any,
          },
          requestB,
          {},
          urlB,
          {},
        ),
      );

      expect(cacheKeys.length).toBe(2);
      expect(cacheKeys[0]).toContain("app.example.com");
      expect(cacheKeys[1]).toContain("staging.example.com");
      expect(cacheKeys[0]).not.toBe(cacheKeys[1]);
    });
  });
});
