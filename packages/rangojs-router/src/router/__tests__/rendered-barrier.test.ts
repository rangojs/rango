import { describe, it, expect, vi, beforeEach } from "vitest";

// Track isInsideLoaderScope mock state
let mockInsideLoaderScope = false;

// Track mock request context
let mockRequestContext: any = null;

vi.mock("../../server/context", () => ({
  track: () => () => {},
  isInsideLoaderScope: () => mockInsideLoaderScope,
}));

vi.mock("../../server/context.js", () => ({
  track: () => () => {},
  isInsideLoaderScope: () => mockInsideLoaderScope,
}));

vi.mock("../../server/request-context.js", () => ({
  getRequestContext: () => mockRequestContext,
  _getRequestContext: () => mockRequestContext,
}));

vi.mock("../../server/fetchable-loader-store.js", () => ({
  getFetchableLoader: () => undefined,
}));

// Real handle module for isHandle + getCollectFn
vi.mock("../../handle.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../handle.js")>("../../handle.js");
  return actual;
});

import { setupLoaderAccess } from "../loader-resolution";
import { createHandle } from "../../handle.js";
import { createHandleStore } from "../../server/handle-store.js";
import type {
  HandlerContext,
  LoaderDefinition,
  LoaderContext,
} from "../../types";

function createMockContext(): HandlerContext<any, any> {
  const url = new URL("http://localhost/test");
  return {
    params: {},
    request: new Request(url.href),
    searchParams: new URLSearchParams(),
    pathname: "/test",
    url,
    env: {},
    get: () => undefined,
    set: () => {},
    use: vi.fn() as any,
    reverse: (() => "/") as any,
  } as any;
}

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

function createMockRequestContext(opts?: { treeHasStreaming?: boolean }): any {
  const handleStore = createHandleStore();
  let resolveBarrier: () => void;
  const barrier = new Promise<void>((resolve) => {
    resolveBarrier = resolve;
  });
  let barrierResolved = false;

  return {
    _handleStore: handleStore,
    _renderBarrier: barrier,
    _resolveRenderBarrier: (segmentOrder: string[]) => {
      if (barrierResolved) return;
      barrierResolved = true;
      mockRequestContext._renderBarrierSegmentOrder = segmentOrder;
      resolveBarrier!();
    },
    _renderBarrierSegmentOrder: undefined,
    _treeHasStreaming: opts?.treeHasStreaming ?? false,
    // Helper to resolve barrier from test code
    _resolveBarrier: resolveBarrier!,
  };
}

describe("rendered barrier", () => {
  beforeEach(() => {
    mockInsideLoaderScope = false;
    mockRequestContext = null;
  });

  describe("rendered() guard: handler-invoked loader", () => {
    it("throws when called from a handler-invoked loader", async () => {
      mockInsideLoaderScope = false;
      mockRequestContext = createMockRequestContext();
      const ctx = createMockContext();
      const loaderPromises = new Map<string, Promise<any>>();

      const loader = createLoader("handlerLoader", async (loaderCtx) => {
        await loaderCtx.rendered();
        return "data";
      });

      setupLoaderAccess(ctx, loaderPromises);

      const result = await Promise.allSettled([ctx.use(loader)]);
      const rejection = result[0] as PromiseRejectedResult;
      expect(rejection.status).toBe("rejected");
      expect(rejection.reason.message).toContain(
        "only available in DSL loaders",
      );
    });
  });

  describe("rendered() guard: streaming tree", () => {
    it("throws when the tree has loading()", async () => {
      mockInsideLoaderScope = true;
      mockRequestContext = createMockRequestContext({
        treeHasStreaming: true,
      });
      const ctx = createMockContext();
      const loaderPromises = new Map<string, Promise<any>>();

      const loader = createLoader("streamingLoader", async (loaderCtx) => {
        await loaderCtx.rendered();
        return "data";
      });

      setupLoaderAccess(ctx, loaderPromises);

      const result = await Promise.allSettled([ctx.use(loader)]);
      const rejection = result[0] as PromiseRejectedResult;
      expect(rejection.status).toBe("rejected");
      expect(rejection.reason.message).toContain(
        "not supported when the matched route tree uses loading()",
      );
    });
  });

  describe("ctx.use(handle) before rendered()", () => {
    it("throws when reading a handle without awaiting rendered() first", async () => {
      mockInsideLoaderScope = true;
      mockRequestContext = createMockRequestContext();
      const ctx = createMockContext();
      const loaderPromises = new Map<string, Promise<any>>();

      const Products = createHandle<string>(undefined, "test#Products");

      const loader = createLoader("noRenderedLoader", async (loaderCtx) => {
        // Try to read handle without rendered()
        return loaderCtx.use(Products);
      });

      setupLoaderAccess(ctx, loaderPromises);

      const result = await Promise.allSettled([ctx.use(loader)]);
      const rejection = result[0] as PromiseRejectedResult;
      expect(rejection.status).toBe("rejected");
      expect(rejection.reason.message).toContain(
        'requires "await ctx.rendered()" first',
      );
    });
  });

  describe("fresh SSR non-streaming", () => {
    it("reads handle data after rendered() resolves", async () => {
      mockInsideLoaderScope = true;
      mockRequestContext = createMockRequestContext();
      const ctx = createMockContext();
      const loaderPromises = new Map<string, Promise<any>>();

      const Products = createHandle<string>(undefined, "test#Products");

      const loader = createLoader("priceLoader", async (loaderCtx) => {
        await loaderCtx.rendered();
        const products = loaderCtx.use(Products);
        return products;
      });

      setupLoaderAccess(ctx, loaderPromises);

      // Start the loader — it will pause at rendered()
      const loaderPromise = ctx.use(loader);

      // Simulate handler pushing handle data
      const handleStore = mockRequestContext._handleStore;
      handleStore.push("test#Products", "root.layout", "product-a");
      handleStore.push("test#Products", "shop.layout", "product-b");

      // Resolve the barrier (simulating segment resolution completing)
      mockRequestContext._resolveRenderBarrier(["root.layout", "shop.layout"]);

      // Loader should complete and return collected handle data
      const result = await loaderPromise;
      expect(result).toEqual(["product-a", "product-b"]);
    });

    it("returns empty array when no handle data was pushed", async () => {
      mockInsideLoaderScope = true;
      mockRequestContext = createMockRequestContext();
      const ctx = createMockContext();
      const loaderPromises = new Map<string, Promise<any>>();

      const Products = createHandle<string>(undefined, "test#EmptyProducts");

      const loader = createLoader("emptyLoader", async (loaderCtx) => {
        await loaderCtx.rendered();
        return loaderCtx.use(Products);
      });

      setupLoaderAccess(ctx, loaderPromises);

      const loaderPromise = ctx.use(loader);
      mockRequestContext._resolveRenderBarrier([]);

      const result = await loaderPromise;
      expect(result).toEqual([]);
    });

    it("rendered() is idempotent — multiple calls return the same promise", async () => {
      mockInsideLoaderScope = true;
      mockRequestContext = createMockRequestContext();
      const ctx = createMockContext();
      const loaderPromises = new Map<string, Promise<any>>();

      let renderedCalls = 0;
      const loader = createLoader("idempotentLoader", async (loaderCtx) => {
        const p1 = loaderCtx.rendered();
        const p2 = loaderCtx.rendered();
        renderedCalls = 2;
        expect(p1).toBe(p2);
        await p1;
        return "done";
      });

      setupLoaderAccess(ctx, loaderPromises);

      const loaderPromise = ctx.use(loader);
      mockRequestContext._resolveRenderBarrier([]);

      const result = await loaderPromise;
      expect(result).toBe("done");
      expect(renderedCalls).toBe(2);
    });

    it("respects segment order when collecting handle data", async () => {
      mockInsideLoaderScope = true;
      mockRequestContext = createMockRequestContext();
      const ctx = createMockContext();
      const loaderPromises = new Map<string, Promise<any>>();

      const Breadcrumbs = createHandle<{ label: string }>(
        undefined,
        "test#Breadcrumbs",
      );

      const loader = createLoader("breadcrumbLoader", async (loaderCtx) => {
        await loaderCtx.rendered();
        return loaderCtx.use(Breadcrumbs);
      });

      setupLoaderAccess(ctx, loaderPromises);

      const loaderPromise = ctx.use(loader);

      // Push in reverse order
      const handleStore = mockRequestContext._handleStore;
      handleStore.push("test#Breadcrumbs", "child.layout", {
        label: "Child",
      });
      handleStore.push("test#Breadcrumbs", "root.layout", {
        label: "Root",
      });

      // But segment order is root -> child
      mockRequestContext._resolveRenderBarrier(["root.layout", "child.layout"]);

      const result = await loaderPromise;
      // Should follow segment order, not push order
      expect(result).toEqual([{ label: "Root" }, { label: "Child" }]);
    });

    it("supports custom collect function on handles", async () => {
      mockInsideLoaderScope = true;
      mockRequestContext = createMockRequestContext();
      const ctx = createMockContext();
      const loaderPromises = new Map<string, Promise<any>>();

      const PageTitle = createHandle<string, string>(
        (segments) => segments.flat().at(-1) ?? "Default",
        "test#PageTitle",
      );

      const loader = createLoader("titleLoader", async (loaderCtx) => {
        await loaderCtx.rendered();
        return loaderCtx.use(PageTitle);
      });

      setupLoaderAccess(ctx, loaderPromises);

      const loaderPromise = ctx.use(loader);

      const handleStore = mockRequestContext._handleStore;
      handleStore.push("test#PageTitle", "root.layout", "Home");
      handleStore.push("test#PageTitle", "shop.route", "Shop");

      mockRequestContext._resolveRenderBarrier(["root.layout", "shop.route"]);

      const result = await loaderPromise;
      expect(result).toBe("Shop");
    });
  });

  describe("cache hit replay", () => {
    it("rendered() resolves immediately when barrier is pre-resolved", async () => {
      mockInsideLoaderScope = true;
      mockRequestContext = createMockRequestContext();
      const ctx = createMockContext();
      const loaderPromises = new Map<string, Promise<any>>();

      const Products = createHandle<string>(undefined, "test#CachedProducts");

      // Pre-resolve barrier (simulating cache hit path)
      const handleStore = mockRequestContext._handleStore;
      handleStore.replaySegmentData("root.layout", {
        "test#CachedProducts": ["cached-product-a"],
      });
      mockRequestContext._resolveRenderBarrier(["root.layout"]);

      const loader = createLoader("cacheLoader", async (loaderCtx) => {
        await loaderCtx.rendered();
        return loaderCtx.use(Products);
      });

      setupLoaderAccess(ctx, loaderPromises);

      const result = await ctx.use(loader);
      expect(result).toEqual(["cached-product-a"]);
    });
  });

  describe("prerender replay", () => {
    it("reads replayed handle data from prerender store", async () => {
      mockInsideLoaderScope = true;
      mockRequestContext = createMockRequestContext();
      const ctx = createMockContext();
      const loaderPromises = new Map<string, Promise<any>>();

      const Meta = createHandle<{ title: string }>(undefined, "test#Meta");

      // Simulate prerender replay
      const handleStore = mockRequestContext._handleStore;
      handleStore.replaySegmentData("page.route", {
        "test#Meta": [{ title: "Prerendered Page" }],
      });
      mockRequestContext._resolveRenderBarrier(["page.route"]);

      const loader = createLoader("prerenderLoader", async (loaderCtx) => {
        await loaderCtx.rendered();
        return loaderCtx.use(Meta);
      });

      setupLoaderAccess(ctx, loaderPromises);

      const result = await ctx.use(loader);
      expect(result).toEqual([{ title: "Prerendered Page" }]);
    });
  });

  describe("rendered() + loader dependencies", () => {
    it("loader can use both rendered() and loader deps", async () => {
      mockInsideLoaderScope = true;
      mockRequestContext = createMockRequestContext();
      const ctx = createMockContext();
      const loaderPromises = new Map<string, Promise<any>>();

      const Products = createHandle<string>(undefined, "test#DepProducts");

      const baseLoader = createLoader("baseLoader", async () => {
        return "base-data";
      });

      const depLoader = createLoader("depLoader", async (loaderCtx) => {
        const base = await loaderCtx.use(baseLoader);
        await loaderCtx.rendered();
        const products = loaderCtx.use(Products);
        return { base, products };
      });

      setupLoaderAccess(ctx, loaderPromises);

      const loaderPromise = ctx.use(depLoader);

      const handleStore = mockRequestContext._handleStore;
      handleStore.push("test#DepProducts", "root.layout", "product-x");
      mockRequestContext._resolveRenderBarrier(["root.layout"]);

      const result = await loaderPromise;
      expect(result).toEqual({
        base: "base-data",
        products: ["product-x"],
      });
    });
  });

  describe("loading: false does not count as streaming", () => {
    it("rendered() works when loading is explicitly false", async () => {
      mockInsideLoaderScope = true;
      // _treeHasStreaming is false because loading:false is not streaming
      mockRequestContext = createMockRequestContext({
        treeHasStreaming: false,
      });
      const ctx = createMockContext();
      const loaderPromises = new Map<string, Promise<any>>();

      const loader = createLoader("loadingFalseLoader", async (loaderCtx) => {
        await loaderCtx.rendered();
        return "ok";
      });

      setupLoaderAccess(ctx, loaderPromises);

      const loaderPromise = ctx.use(loader);
      mockRequestContext._resolveRenderBarrier([]);

      const result = await loaderPromise;
      expect(result).toBe("ok");
    });
  });

  describe("deadlock detection", () => {
    it("throws when handler awaits a loader that called rendered()", async () => {
      mockInsideLoaderScope = true;
      mockRequestContext = createMockRequestContext();
      const ctx = createMockContext();
      const loaderPromises = new Map<string, Promise<any>>();

      const loader = createLoader("deadlockLoader", async (loaderCtx) => {
        await loaderCtx.rendered();
        return "data";
      });

      setupLoaderAccess(ctx, loaderPromises);

      // Start the DSL loader — it will call rendered() and register as a waiter
      const _dslPromise = ctx.use(loader);

      // Give the loader microtask time to call rendered()
      await new Promise((resolve) => setTimeout(resolve, 0));

      // Now simulate handler calling ctx.use(sameLoader) — should throw
      // Reset to non-DSL scope for the handler call
      mockInsideLoaderScope = false;
      expect(() => ctx.use(loader)).toThrow("Deadlock");
    });

    it("does NOT throw when DSL resolves a rendered() loader from another segment", async () => {
      mockInsideLoaderScope = true;
      mockRequestContext = createMockRequestContext();
      const ctx = createMockContext();
      const loaderPromises = new Map<string, Promise<any>>();

      const Products = createHandle<string>(undefined, "test#DedupProducts");

      const loader = createLoader("dedupLoader", async (loaderCtx) => {
        await loaderCtx.rendered();
        return loaderCtx.use(Products);
      });

      setupLoaderAccess(ctx, loaderPromises);

      // First DSL segment starts the loader — calls rendered(), registers waiter
      const firstPromise = ctx.use(loader);
      await new Promise((resolve) => setTimeout(resolve, 0));

      // Second DSL segment resolves the same loader (still inside loader scope)
      // This should NOT throw — it's DSL-to-DSL memoization, not a handler deadlock
      expect(() => ctx.use(loader)).not.toThrow();

      // Both get the same memoized promise
      const secondPromise = ctx.use(loader);
      expect(firstPromise).toBe(secondPromise);
    });
  });
});
