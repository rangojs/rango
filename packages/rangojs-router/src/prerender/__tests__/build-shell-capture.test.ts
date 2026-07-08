import { describe, expect, it, vi } from "vitest";
import { RouteNotFoundError } from "../../errors.js";
import type { BuildShellCaptureOptions } from "../build-shell-capture.js";
import type { MiddlewareEntry, MiddlewareFn } from "../../router/middleware.js";
import { getRequestContext } from "../../server/request-context.js";

vi.mock("../../deps/rsc.js", () => ({
  renderToReadableStream: vi.fn(),
}));

// buildFullPayload runs after the target match resolves; its output only feeds
// the (mocked) render stream, so a trivial payload is enough to reach capture.
vi.mock("../../rsc/full-payload.js", () => ({
  buildFullPayload: () => ({}),
}));

// Stub ONLY captureAndStoreShell so the render/capture terminal is controllable;
// deriveShellCaptureContext (and the retry delay) stay real so the derived
// context — and its _dynamic prototype read — behave as in production.
const { captureAndStoreShellMock } = vi.hoisted(() => ({
  captureAndStoreShellMock: vi.fn(),
}));
vi.mock("../../rsc/shell-capture.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../rsc/shell-capture.js")>();
  return { ...actual, captureAndStoreShell: captureAndStoreShellMock };
});

const { captureShellForBuild } = await import("../build-shell-capture.js");

/** The 5th arg captureAndStoreShell receives — the shell descriptor + sink. */
interface CaptureDescriptorStub {
  store: {
    putShell: (
      key: string,
      entry: unknown,
      ...rest: unknown[]
    ) => Promise<void>;
  };
  key: string;
  ttl?: number;
  swr?: number;
  tags?: string[];
}

function makeOptions(router: unknown): BuildShellCaptureOptions {
  return {
    router,
    urlPath: "/shop/power-set",
    routeName: "shop.category",
    key: "/shop/power-set:shell",
    buildVersion: "test-version",
    captureShellHTML: vi.fn() as BuildShellCaptureOptions["captureShellHTML"],
  };
}

describe("captureShellForBuild", () => {
  it("treats a plain pathname miss as a route mismatch", async () => {
    const router = {
      match: vi.fn(async () => {
        throw new RouteNotFoundError("No route matched for /shop/power-set", {
          cause: { pathname: "/shop/power-set", method: "GET" },
        });
      }),
    };

    await expect(captureShellForBuild(makeOptions(router))).resolves.toEqual({
      outcome: "route-mismatch",
      matchedRouteName: undefined,
    });
  });

  it("reports the matched route name when another route claims the path", async () => {
    const router = {
      match: vi.fn(async () => ({ routeName: "shop.catchall" })),
    };

    await expect(captureShellForBuild(makeOptions(router))).resolves.toEqual({
      outcome: "route-mismatch",
      matchedRouteName: "shop.catchall",
    });
  });

  it("does not swallow route-load failures encoded as RouteNotFoundError", async () => {
    const error = new RouteNotFoundError(
      "Failed to load route handlers for /shop/power-set: boom",
      {
        cause: {
          state: { path: "/shop/power-set", routeKey: "shop.category" },
        },
      },
    );
    const router = {
      match: vi.fn(async () => {
        throw error;
      }),
    };

    await expect(captureShellForBuild(makeOptions(router))).rejects.toBe(error);
  });

  it("runs build middleware and lets ctx.dynamic() opt out of shell capture", async () => {
    const events: string[] = [];
    let waitUntilRan = false;

    const globalMiddleware: MiddlewareEntry = {
      pattern: null,
      regex: null,
      paramNames: [],
      handler: async (ctx, next) => {
        events.push(`global:${ctx.build}`);
        const response = await next();
        events.push(`global-after:${ctx.routeName}`);
        return response;
      },
    };
    const routeMiddleware: MiddlewareFn = async (ctx, next) => {
      events.push(`route:${ctx.build}:${ctx.params.category}`);
      ctx.waitUntil(async () => {
        waitUntilRan = true;
      });
      ctx.dynamic();
      return next();
    };
    const router = {
      middleware: [globalMiddleware],
      previewMatch: vi.fn(async () => ({
        routeKey: "shop.category",
        params: { category: "power-set" },
        routeMiddleware: [
          { handler: routeMiddleware, params: { category: "power-set" } },
        ],
      })),
      match: vi.fn(async () => {
        throw new Error("capture should not run after ctx.dynamic()");
      }),
    };

    await expect(captureShellForBuild(makeOptions(router))).resolves.toEqual({
      outcome: "dynamic",
    });
    expect(router.match).not.toHaveBeenCalled();
    expect(waitUntilRan).toBe(false);
    expect(events).toEqual([
      "global:true",
      "route:true:power-set",
      "global-after:shop.category",
    ]);
  });

  it("runs global + route middleware to completion (no opt-out) and stores the shell", async () => {
    captureAndStoreShellMock.mockReset();
    captureAndStoreShellMock.mockImplementation(async (..._args: unknown[]) => {
      const descriptor = _args[4] as CaptureDescriptorStub;
      await descriptor.store.putShell(
        descriptor.key,
        { buildVersion: "test-version" },
        descriptor.ttl,
        descriptor.swr,
        descriptor.tags,
      );
      return "stored";
    });

    const events: string[] = [];
    const globalMiddleware: MiddlewareEntry = {
      pattern: null,
      regex: null,
      paramNames: [],
      handler: async (ctx, next) => {
        events.push(`global:${ctx.build}`);
        const response = await next();
        events.push("global-after");
        return response;
      },
    };
    const routeMiddleware: MiddlewareFn = async (ctx, next) => {
      events.push(`route:${ctx.params.category}`);
      const response = await next();
      events.push("route-after");
      return response;
    };
    const router = {
      middleware: [globalMiddleware],
      previewMatch: vi.fn(async () => ({
        routeKey: "shop.category",
        params: { category: "power-set" },
        routeMiddleware: [
          { handler: routeMiddleware, params: { category: "power-set" } },
        ],
      })),
      match: vi.fn(async () => ({
        routeName: "shop.category",
        params: { category: "power-set" },
      })),
    };

    const result = await captureShellForBuild(makeOptions(router));
    expect(result.outcome).toBe("stored");
    expect(result.entry).toEqual({ buildVersion: "test-version" });
    expect(captureAndStoreShellMock).toHaveBeenCalledTimes(1);
    // Both layers wrapped the capture: global outermost, route innermost.
    expect(events).toEqual([
      "global:true",
      "route:power-set",
      "route-after",
      "global-after",
    ]);
  });

  it("a bake-lane opt-out DURING the capture render discards the shell (outcome 'dynamic')", async () => {
    captureAndStoreShellMock.mockReset();
    // A loader/handler calling ctx.dynamic() while the shell renders: the
    // captured shell is collected but then discarded because the request opted
    // onto the dynamic axis (build-shell-capture reads derivedCtx._dynamic).
    captureAndStoreShellMock.mockImplementation(async (..._args: unknown[]) => {
      const descriptor = _args[4] as CaptureDescriptorStub;
      getRequestContext()!.dynamic();
      await descriptor.store.putShell(descriptor.key, {});
      return "stored";
    });

    const router = {
      previewMatch: vi.fn(async () => ({
        routeKey: "shop.category",
        params: { category: "power-set" },
      })),
      match: vi.fn(async () => ({
        routeName: "shop.category",
        params: { category: "power-set" },
      })),
    };

    const result = await captureShellForBuild(makeOptions(router));
    expect(result).toEqual({ outcome: "dynamic" });
    expect(result.entry).toBeUndefined();
    expect(captureAndStoreShellMock).toHaveBeenCalledTimes(1);
  });
});
