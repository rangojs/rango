/**
 * Tests for the RequestScope feature: `executionContext` and `waitUntil`
 * exposure on every user-facing request context.
 *
 * We don't re-test every context type's full shape here — the type system
 * + the existing context tests do that. What this file pins:
 * 1. `executionContext` passed into `createRequestContext` is surfaced
 *    on the public request context.
 * 2. `waitUntil` delegates to `executionContext.waitUntil` when present,
 *    and falls back to fire-and-forget otherwise.
 * 3. Handler, Middleware, Loader, and Response handler contexts all see
 *    the same ExecutionContext instance and the same `originalUrl`.
 */

import { describe, it, expect, vi } from "vitest";

// Mock cache-scope to avoid virtual module chain (see response-route-handler.test.ts).
vi.mock("../../cache/cache-scope.js", () => ({
  createCacheScope: vi.fn(() => null),
}));

import {
  createRequestContext,
  runWithRequestContext,
  type ExecutionContext,
} from "../request-context.js";
import { createHandlerContext } from "../../router/handler-context.js";
import { createMiddlewareContext } from "../../router/middleware.js";
import type { ResponseHolder } from "../../router/middleware-types.js";
import { setupLoaderAccess } from "../../router/loader-resolution.js";
import { handleResponseRoute } from "../../rsc/response-route-handler.js";
import type { ResponseRouteMatch } from "../../rsc/response-route-handler.js";
import type { HandlerContext as RscHandlerContext } from "../../rsc/handler-context.js";
import type { LoaderDefinition } from "../../types/loader-types.js";

function createMockExecutionContext(): ExecutionContext & {
  waitUntil: ReturnType<typeof vi.fn>;
  passThroughOnException: ReturnType<typeof vi.fn>;
} {
  return {
    waitUntil: vi.fn<(p: Promise<unknown>) => void>(),
    passThroughOnException: vi.fn<() => void>(),
  };
}

describe("RequestScope: executionContext + waitUntil", () => {
  describe("RequestContext (ALS-bound, public)", () => {
    it("exposes the ExecutionContext passed into createRequestContext", () => {
      const mockEC = createMockExecutionContext();
      const url = new URL("https://example.com/foo");
      const ctx = createRequestContext({
        env: {},
        request: new Request(url),
        url,
        variables: {},
        executionContext: mockEC,
      });
      expect(ctx.executionContext).toBe(mockEC);
    });

    it("executionContext is undefined when none was provided", () => {
      const url = new URL("https://example.com/foo");
      const ctx = createRequestContext({
        env: {},
        request: new Request(url),
        url,
        variables: {},
      });
      expect(ctx.executionContext).toBeUndefined();
    });

    it("waitUntil delegates to ExecutionContext.waitUntil when present", () => {
      const mockEC = createMockExecutionContext();
      const url = new URL("https://example.com/foo");
      const ctx = createRequestContext({
        env: {},
        request: new Request(url),
        url,
        variables: {},
        executionContext: mockEC,
      });

      const work = Promise.resolve();
      ctx.waitUntil(() => work);
      expect(mockEC.waitUntil).toHaveBeenCalledTimes(1);
    });

    it("waitUntil falls back to fire-and-forget when no ExecutionContext", async () => {
      const url = new URL("https://example.com/foo");
      const ctx = createRequestContext({
        env: {},
        request: new Request(url),
        url,
        variables: {},
      });

      // Rejected promise should be caught (not unhandled) and logged.
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        ctx.waitUntil(async () => {
          throw new Error("background task failed");
        });
        // Flush the microtask queue. fireAndForgetWaitUntil defers fn() via
        // Promise.resolve().then(fn) (H2), which adds microtask hops before
        // the rejection is caught; a macrotask boundary drains them all.
        await new Promise((r) => setTimeout(r, 0));
        expect(errorSpy).toHaveBeenCalled();
      } finally {
        errorSpy.mockRestore();
      }
    });

    // H2: a non-async callback that throws SYNCHRONOUSLY (sync setup before its
    // first await) must be fire-and-forget too — it must NOT escape into the
    // caller. Without the deferral, fn() runs before .catch() is attached.
    it("does NOT throw into the caller when a sync-throwing callback runs without an ExecutionContext", async () => {
      const url = new URL("https://example.com/foo");
      const ctx = createRequestContext({
        env: {},
        request: new Request(url),
        url,
        variables: {},
      });

      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        expect(() =>
          ctx.waitUntil((() => {
            throw new Error("sync setup blew up");
          }) as unknown as () => Promise<void>),
        ).not.toThrow();
        await new Promise((r) => setTimeout(r, 0));
        // Still logged as a background failure, not lost.
        expect(errorSpy).toHaveBeenCalled();
      } finally {
        errorSpy.mockRestore();
      }
    });

    // H2 (CF seat): same guarantee when an ExecutionContext IS present — the
    // sync throw must not escape; the host's waitUntil receives a (rejected)
    // promise instead.
    it("does NOT throw into the caller when a sync-throwing callback runs WITH an ExecutionContext", () => {
      const mockEC = createMockExecutionContext();
      const url = new URL("https://example.com/foo");
      const ctx = createRequestContext({
        env: {},
        request: new Request(url),
        url,
        variables: {},
        executionContext: mockEC,
      });

      expect(() =>
        ctx.waitUntil((() => {
          throw new Error("sync setup blew up");
        }) as unknown as () => Promise<void>),
      ).not.toThrow();
      // The host still received a promise to keep alive (the rejected one).
      expect(mockEC.waitUntil).toHaveBeenCalledTimes(1);
      const arg = mockEC.waitUntil.mock.calls[0][0];
      expect(arg).toBeInstanceOf(Promise);
      // Swallow the rejection so it doesn't surface as unhandled.
      (arg as Promise<unknown>).catch(() => {});
    });

    it("marks build contexts and keeps waitUntil side-effect free during build", async () => {
      const mockEC = createMockExecutionContext();
      const url = new URL("https://example.com/foo");
      let ran = false;
      const ctx = createRequestContext({
        env: {},
        request: new Request(url),
        url,
        variables: {},
        executionContext: mockEC,
        build: true,
      });

      ctx.waitUntil(async () => {
        ran = true;
      });
      ctx.dynamic();
      await new Promise((r) => setTimeout(r, 0));

      expect(ctx.build).toBe(true);
      expect(ctx._dynamic).toBe(true);
      expect(mockEC.waitUntil).not.toHaveBeenCalled();
      expect(ran).toBe(false);
    });
  });

  describe("HandlerContext", () => {
    it("inherits executionContext from the ALS-bound RequestContext", () => {
      const mockEC = createMockExecutionContext();
      const url = new URL("https://example.com/mailbox/ivo@example.com");
      const reqCtx = createRequestContext({
        env: {},
        request: new Request(url),
        url,
        variables: {},
        executionContext: mockEC,
      });

      runWithRequestContext(reqCtx, () => {
        const handlerCtx = createHandlerContext(
          {},
          new Request(url),
          url.searchParams,
          url.pathname,
          url,
        );
        expect(handlerCtx.executionContext).toBe(mockEC);
      });
    });

    it("waitUntil forwards to the ALS-bound RequestContext", () => {
      const mockEC = createMockExecutionContext();
      const url = new URL("https://example.com/foo");
      const reqCtx = createRequestContext({
        env: {},
        request: new Request(url),
        url,
        variables: {},
        executionContext: mockEC,
      });

      runWithRequestContext(reqCtx, () => {
        const handlerCtx = createHandlerContext(
          {},
          new Request(url),
          url.searchParams,
          url.pathname,
          url,
        );
        handlerCtx.waitUntil(() => Promise.resolve());
        expect(mockEC.waitUntil).toHaveBeenCalledTimes(1);
      });
    });

    it("originalUrl preserves _rsc* params stripped from url", () => {
      const url = new URL("https://example.com/foo?_rsc_partial=1&page=2");
      const reqCtx = createRequestContext({
        env: {},
        request: new Request(url),
        url,
        variables: {},
      });

      runWithRequestContext(reqCtx, () => {
        const handlerCtx = createHandlerContext(
          {},
          new Request(url),
          url.searchParams,
          url.pathname,
          url,
        );
        // url is passed through; originalUrl is reconstructed from the raw
        // request URL inside createHandlerContext.
        expect(handlerCtx.originalUrl.searchParams.get("_rsc_partial")).toBe(
          "1",
        );
      });
    });

    it("exposes build and delegates dynamic() to the ALS-bound RequestContext", () => {
      const url = new URL("https://example.com/foo");
      const reqCtx = createRequestContext({
        env: {},
        request: new Request(url),
        url,
        variables: {},
        build: true,
      });

      runWithRequestContext(reqCtx, () => {
        const handlerCtx = createHandlerContext(
          {},
          new Request(url),
          url.searchParams,
          url.pathname,
          url,
        );
        expect(handlerCtx.build).toBe(true);
        handlerCtx.dynamic();
        expect(reqCtx._dynamic).toBe(true);
      });
    });
  });

  describe("MiddlewareContext", () => {
    it("exposes executionContext via a lazy getter", () => {
      const mockEC = createMockExecutionContext();
      const url = new URL("https://example.com/foo");
      const reqCtx = createRequestContext({
        env: {},
        request: new Request(url),
        url,
        variables: {},
        executionContext: mockEC,
      });

      runWithRequestContext(reqCtx, () => {
        const responseHolder: ResponseHolder = {
          response: new Response(null, { status: 200 }),
        };
        const mwCtx = createMiddlewareContext(
          new Request(url),
          {},
          {},
          {},
          responseHolder,
        );
        expect(mwCtx.executionContext).toBe(mockEC);
      });
    });

    it("waitUntil forwards to the ALS-bound RequestContext", () => {
      const mockEC = createMockExecutionContext();
      const url = new URL("https://example.com/foo");
      const reqCtx = createRequestContext({
        env: {},
        request: new Request(url),
        url,
        variables: {},
        executionContext: mockEC,
      });

      runWithRequestContext(reqCtx, () => {
        const responseHolder: ResponseHolder = {
          response: new Response(null, { status: 200 }),
        };
        const mwCtx = createMiddlewareContext(
          new Request(url),
          {},
          {},
          {},
          responseHolder,
        );
        mwCtx.waitUntil(() => Promise.resolve());
        expect(mockEC.waitUntil).toHaveBeenCalledTimes(1);
      });
    });

    it("waitUntil falls back safely when no request context is bound", async () => {
      // Construct a middleware ctx outside any runWithRequestContext call.
      // This is unusual, but the router should not crash.
      const url = new URL("https://example.com/foo");
      const responseHolder: ResponseHolder = {
        response: new Response(null, { status: 200 }),
      };
      const mwCtx = createMiddlewareContext(
        new Request(url),
        {},
        {},
        {},
        responseHolder,
      );

      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        mwCtx.waitUntil(async () => {
          throw new Error("boom");
        });
        // Flush microtasks for the H2 deferral (see note above).
        await new Promise((r) => setTimeout(r, 0));
        expect(errorSpy).toHaveBeenCalled();
      } finally {
        errorSpy.mockRestore();
      }
    });

    it("exposes build and delegates dynamic() to the ALS-bound RequestContext", () => {
      const url = new URL("https://example.com/foo");
      const reqCtx = createRequestContext({
        env: {},
        request: new Request(url),
        url,
        variables: {},
        build: true,
      });

      runWithRequestContext(reqCtx, () => {
        const responseHolder: ResponseHolder = {
          response: new Response(null, { status: 200 }),
        };
        const mwCtx = createMiddlewareContext(
          new Request(url),
          {},
          {},
          {},
          responseHolder,
        );
        expect(mwCtx.build).toBe(true);
        mwCtx.dynamic();
        expect(reqCtx._dynamic).toBe(true);
      });
    });
  });

  describe("LoaderContext", () => {
    it("forwards executionContext, originalUrl, and waitUntil from the handler ctx", async () => {
      const mockEC = createMockExecutionContext();
      const url = new URL("https://example.com/products/42?_rsc_v=1&page=2");
      const reqCtx = createRequestContext({
        env: {},
        request: new Request(url),
        url,
        variables: {},
        executionContext: mockEC,
      });

      let capturedLoaderCtx: any;
      const loader: LoaderDefinition<{ ok: true }> = {
        __brand: "loader",
        $$id: "test-loader",
        fn: (loaderCtx) => {
          capturedLoaderCtx = loaderCtx;
          return Promise.resolve({ ok: true } as const);
        },
      };

      await runWithRequestContext(reqCtx, async () => {
        const handlerCtx = createHandlerContext(
          {},
          new Request(url),
          url.searchParams,
          url.pathname,
          url,
        );
        setupLoaderAccess(handlerCtx, new Map());
        await handlerCtx.use(loader);
      });

      expect(capturedLoaderCtx.executionContext).toBe(mockEC);
      // originalUrl preserves _rsc* params the way RequestScope guarantees.
      expect(capturedLoaderCtx.originalUrl.searchParams.get("_rsc_v")).toBe(
        "1",
      );
      // waitUntil forwards to the CF ctx.
      capturedLoaderCtx.waitUntil(() => Promise.resolve());
      expect(mockEC.waitUntil).toHaveBeenCalledTimes(1);
    });
  });

  describe("ResponseHandlerContext", () => {
    it("exposes executionContext and originalUrl on response-route handlers", async () => {
      const mockEC = createMockExecutionContext();
      const url = new URL("https://example.com/mcp/stream?_rsc_v=1&token=abc");
      const request = new Request(url);
      const reqCtx = createRequestContext({
        env: {},
        request,
        url,
        variables: {},
        executionContext: mockEC,
      });

      // Minimal mock of the RSC handler-context bundle used by
      // handleResponseRoute — only getRequiredRouteMap is hit for the ctx
      // build path we care about.
      const rscHandlerCtx = {
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
        getRequiredRouteMap: () => ({}) as Record<string, string>,
        createRedirectFlightResponse: vi.fn() as any,
        resolveStreamMode: async () => "stream" as const,
      } as unknown as RscHandlerContext<unknown>;

      let capturedCtx: any;
      const preview: ResponseRouteMatch = {
        responseType: "json",
        handler: (ctx: any) => {
          capturedCtx = ctx;
          return { ok: true };
        },
        params: {},
      };

      await runWithRequestContext(reqCtx, () =>
        handleResponseRoute(rscHandlerCtx, preview, request, {}, url, {}),
      );

      // The raw CF ExecutionContext is reachable on ctx (the whole point —
      // MCP / routeAgentRequest can be called directly).
      expect(capturedCtx.executionContext).toBe(mockEC);
      // originalUrl keeps internal _rsc* params; url has them stripped.
      expect(capturedCtx.originalUrl.searchParams.get("_rsc_v")).toBe("1");
      expect(capturedCtx.url.searchParams.has("_rsc_v")).toBe(false);
      // waitUntil on the response ctx forwards to the CF ctx.
      capturedCtx.waitUntil(() => Promise.resolve());
      expect(mockEC.waitUntil).toHaveBeenCalledTimes(1);
    });
  });
});
