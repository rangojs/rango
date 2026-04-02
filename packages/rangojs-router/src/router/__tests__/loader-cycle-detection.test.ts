import { describe, it, expect, vi } from "vitest";

// Mock dependencies before importing the module under test
vi.mock("../../server/context", () => ({
  track: () => () => {},
  isInsideLoaderScope: () => false,
}));

vi.mock("../../server/request-context.js", () => ({
  getRequestContext: () => undefined,
  _getRequestContext: () => undefined,
}));

vi.mock("../../server/fetchable-loader-store.js", () => ({
  getFetchableLoader: () => undefined,
}));

vi.mock("../../handle.js", () => ({
  isHandle: () => false,
}));

import {
  setupLoaderAccess,
  setupLoaderAccessSilent,
} from "../loader-resolution";
import type {
  HandlerContext,
  LoaderDefinition,
  LoaderContext,
} from "../../types";

/**
 * Create a minimal mock HandlerContext for testing loader resolution.
 */
function createMockContext(): HandlerContext<any, any> {
  const url = new URL("http://localhost/test");
  return {
    params: { slug: "from-route", tenant: "acme" },
    request: new Request(url.href),
    searchParams: new URLSearchParams(),
    pathname: "/test",
    url,
    env: {},
    var: {},
    get: () => undefined,
    set: () => {},
    header: () => {},
    status: () => {},
    html: () => new Response(""),
    json: () => new Response(""),
    text: () => new Response(""),
    redirect: () => new Response(""),
    notFound: () => {
      throw new Error("not implemented");
    },
    use: vi.fn() as any,
  } as any;
}

/**
 * Create a mock LoaderDefinition with a given ID and function.
 */
function createLoader(
  id: string,
  fn: (ctx: LoaderContext<any, any>) => any,
): LoaderDefinition<any, any> {
  return {
    __brand: "loader" as const,
    $$id: id,
    fn,
  };
}

describe("loader cycle detection", () => {
  describe("setupLoaderAccess", () => {
    it("exposes trusted routeParams alongside params", async () => {
      const ctx = createMockContext();
      const loaderPromises = new Map<string, Promise<any>>();

      const loader: LoaderDefinition<any, any> = createLoader(
        "routeParamsLoader",
        async (loaderCtx) => ({
          params: loaderCtx.params,
          routeParams: loaderCtx.routeParams,
        }),
      );

      setupLoaderAccess(ctx, loaderPromises);

      const result = await ctx.use(loader);
      expect(result).toEqual({
        params: { slug: "from-route", tenant: "acme" },
        routeParams: { slug: "from-route", tenant: "acme" },
      });
    });

    it("should detect direct circular dependency (A -> B -> A)", async () => {
      const ctx = createMockContext();
      const loaderPromises = new Map<string, Promise<any>>();

      // loaderB depends on loaderA, loaderA depends on loaderB
      const loaderA: LoaderDefinition<any, any> = createLoader(
        "loaderA",
        async (loaderCtx) => {
          const b = await loaderCtx.use(loaderB);
          return { a: true, b };
        },
      );

      const loaderB: LoaderDefinition<any, any> = createLoader(
        "loaderB",
        async (loaderCtx) => {
          const a = await loaderCtx.use(loaderA);
          return { b: true, a };
        },
      );

      setupLoaderAccess(ctx, loaderPromises);

      // Start both loaders - the cycle should be detected and cause rejection
      const resultA = ctx.use(loaderA);
      const resultB = ctx.use(loaderB);

      // At least one of the promises should reject with a cycle error
      const results = await Promise.allSettled([resultA, resultB]);
      const rejections = results.filter((r) => r.status === "rejected");

      expect(rejections.length).toBeGreaterThanOrEqual(1);
      const error = (rejections[0] as PromiseRejectedResult).reason;
      expect(error.message).toContain("Circular loader dependency detected");
      expect(error.message).toContain("loaderA");
      expect(error.message).toContain("loaderB");
    });

    it("should detect three-way circular dependency (A -> B -> C -> A)", async () => {
      const ctx = createMockContext();
      const loaderPromises = new Map<string, Promise<any>>();

      const loaderA: LoaderDefinition<any, any> = createLoader(
        "loaderA",
        async (loaderCtx) => {
          return await loaderCtx.use(loaderB);
        },
      );

      const loaderB: LoaderDefinition<any, any> = createLoader(
        "loaderB",
        async (loaderCtx) => {
          return await loaderCtx.use(loaderC);
        },
      );

      const loaderC: LoaderDefinition<any, any> = createLoader(
        "loaderC",
        async (loaderCtx) => {
          return await loaderCtx.use(loaderA);
        },
      );

      setupLoaderAccess(ctx, loaderPromises);

      const resultA = ctx.use(loaderA);

      const results = await Promise.allSettled([resultA]);
      const rejection = results[0] as PromiseRejectedResult;

      expect(rejection.status).toBe("rejected");
      expect(rejection.reason.message).toContain(
        "Circular loader dependency detected",
      );
      // The cycle chain should include all three loaders
      expect(rejection.reason.message).toContain("loaderA");
      expect(rejection.reason.message).toContain("loaderB");
      expect(rejection.reason.message).toContain("loaderC");
    });

    it("should allow diamond dependencies without false positives", async () => {
      const ctx = createMockContext();
      const loaderPromises = new Map<string, Promise<any>>();

      // Diamond: A -> B, A -> C, B -> D, C -> D
      // D is shared but no cycle exists
      const loaderD: LoaderDefinition<any, any> = createLoader(
        "loaderD",
        async () => {
          return "D-data";
        },
      );

      const loaderB: LoaderDefinition<any, any> = createLoader(
        "loaderB",
        async (loaderCtx) => {
          const d = await loaderCtx.use(loaderD);
          return { b: true, d };
        },
      );

      const loaderC: LoaderDefinition<any, any> = createLoader(
        "loaderC",
        async (loaderCtx) => {
          const d = await loaderCtx.use(loaderD);
          return { c: true, d };
        },
      );

      const loaderA: LoaderDefinition<any, any> = createLoader(
        "loaderA",
        async (loaderCtx) => {
          const [b, c] = await Promise.all([
            loaderCtx.use(loaderB),
            loaderCtx.use(loaderC),
          ]);
          return { a: true, b, c };
        },
      );

      setupLoaderAccess(ctx, loaderPromises);

      const result = await ctx.use(loaderA);
      expect(result).toEqual({
        a: true,
        b: { b: true, d: "D-data" },
        c: { c: true, d: "D-data" },
      });
    });

    it("should allow linear dependencies (A -> B -> C)", async () => {
      const ctx = createMockContext();
      const loaderPromises = new Map<string, Promise<any>>();

      const loaderC: LoaderDefinition<any, any> = createLoader(
        "loaderC",
        async () => {
          return "C-data";
        },
      );

      const loaderB: LoaderDefinition<any, any> = createLoader(
        "loaderB",
        async (loaderCtx) => {
          const c = await loaderCtx.use(loaderC);
          return { b: true, c };
        },
      );

      const loaderA: LoaderDefinition<any, any> = createLoader(
        "loaderA",
        async (loaderCtx) => {
          const b = await loaderCtx.use(loaderB);
          return { a: true, b };
        },
      );

      setupLoaderAccess(ctx, loaderPromises);

      const result = await ctx.use(loaderA);
      expect(result).toEqual({
        a: true,
        b: { b: true, c: "C-data" },
      });
    });

    it("should still memoize loaders (same loader called twice returns same promise)", async () => {
      const ctx = createMockContext();
      const loaderPromises = new Map<string, Promise<any>>();

      let callCount = 0;
      const loader: LoaderDefinition<any, any> = createLoader(
        "memoized",
        async () => {
          callCount++;
          return "data";
        },
      );

      setupLoaderAccess(ctx, loaderPromises);

      const p1 = ctx.use(loader);
      const p2 = ctx.use(loader);

      // Same promise reference
      expect(p1).toBe(p2);

      const result = await p1;
      expect(result).toBe("data");
      expect(callCount).toBe(1);
    });

    it("should include the full cycle path in the error message", async () => {
      const ctx = createMockContext();
      const loaderPromises = new Map<string, Promise<any>>();

      const loaderA: LoaderDefinition<any, any> = createLoader(
        "auth",
        async (loaderCtx) => {
          return await loaderCtx.use(loaderB);
        },
      );

      const loaderB: LoaderDefinition<any, any> = createLoader(
        "user",
        async (loaderCtx) => {
          return await loaderCtx.use(loaderA);
        },
      );

      setupLoaderAccess(ctx, loaderPromises);

      const result = await Promise.allSettled([ctx.use(loaderA)]);
      const rejection = result[0] as PromiseRejectedResult;

      expect(rejection.status).toBe("rejected");
      // Should show the cycle chain: auth -> user -> auth
      expect(rejection.reason.message).toMatch(
        /Circular loader dependency detected: .+ -> .+ -> .+/,
      );
    });
  });

  describe("setupLoaderAccessSilent", () => {
    it("exposes trusted routeParams in silent mode", async () => {
      const ctx = createMockContext();
      const loaderPromises = new Map<string, Promise<any>>();

      const loader: LoaderDefinition<any, any> = createLoader(
        "silentRouteParamsLoader",
        async (loaderCtx) => ({
          params: loaderCtx.params,
          routeParams: loaderCtx.routeParams,
        }),
      );

      setupLoaderAccessSilent(ctx, loaderPromises);

      const result = await ctx.use(loader);
      expect(result).toEqual({
        params: { slug: "from-route", tenant: "acme" },
        routeParams: { slug: "from-route", tenant: "acme" },
      });
    });

    it("should detect circular dependency in silent mode", async () => {
      const ctx = createMockContext();
      const loaderPromises = new Map<string, Promise<any>>();

      const loaderA: LoaderDefinition<any, any> = createLoader(
        "silentA",
        async (loaderCtx) => {
          return await loaderCtx.use(loaderB);
        },
      );

      const loaderB: LoaderDefinition<any, any> = createLoader(
        "silentB",
        async (loaderCtx) => {
          return await loaderCtx.use(loaderA);
        },
      );

      setupLoaderAccessSilent(ctx, loaderPromises);

      const results = await Promise.allSettled([ctx.use(loaderA)]);
      const rejection = results[0] as PromiseRejectedResult;

      expect(rejection.status).toBe("rejected");
      expect(rejection.reason.message).toContain(
        "Circular loader dependency detected",
      );
      expect(rejection.reason.message).toContain("silentA");
      expect(rejection.reason.message).toContain("silentB");
    });

    it("should allow valid dependencies in silent mode", async () => {
      const ctx = createMockContext();
      const loaderPromises = new Map<string, Promise<any>>();

      const loaderB: LoaderDefinition<any, any> = createLoader(
        "silentB",
        async () => "B-data",
      );

      const loaderA: LoaderDefinition<any, any> = createLoader(
        "silentA",
        async (loaderCtx) => {
          const b = await loaderCtx.use(loaderB);
          return { a: true, b };
        },
      );

      setupLoaderAccessSilent(ctx, loaderPromises);

      const result = await ctx.use(loaderA);
      expect(result).toEqual({ a: true, b: "B-data" });
    });
  });
});
