import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  wrapLoaderWithErrorHandling,
  setupLoaderAccess,
  revalidate,
} from "../loader-resolution";
import type { HandlerContext, LoaderDefinition, ErrorInfo } from "../../types";
import type { EntryData } from "../../server/context";
import React from "react";

// Mock the track function
vi.mock("../../server/context", () => ({
  track: vi.fn(() => vi.fn()),
}));

// Mock the isHandle function
vi.mock("../../handle.js", () => ({
  isHandle: vi.fn((item) => item?.__brand === "handle"),
}));

// Helper to create a minimal handler context
const createContext = (
  overrides: Partial<HandlerContext<any, any>> = {}
): HandlerContext<any, any> => {
  const variables: Record<string, any> = {};
  return {
    params: {},
    request: new Request("http://localhost/"),
    searchParams: new URLSearchParams(),
    pathname: "/",
    url: new URL("http://localhost/"),
    env: {},
    var: variables,
    get: (key: string) => variables[key],
    set: (key: string, value: any) => {
      variables[key] = value;
    },
    _originalRequest: new Request("http://localhost/"),
    use: () => {
      throw new Error("not implemented");
    },
    ...overrides,
  };
};

// Helper to create a loader definition
const createLoader = <T>(
  name: string,
  fn: () => T | Promise<T>
): LoaderDefinition<T> => ({
  __brand: "loader",
  name,
  fn: fn as any,
});

// Helper to create minimal entry data
const createEntry = (
  overrides: Partial<EntryData> = {}
): EntryData =>
  ({
    type: "route",
    id: "test-entry",
    shortCode: "R0",
    handler: null,
    errorBoundary: [],
    notFoundBoundary: [],
    middleware: [],
    revalidate: [],
    loader: [],
    layout: [],
    parallel: [],
    intercept: [],
    parent: null,
    ...overrides,
  } as unknown as EntryData);

describe("wrapLoaderWithErrorHandling", () => {
  const mockCreateErrorInfo = (
    error: unknown,
    segmentId: string,
    segmentType: ErrorInfo["segmentType"]
  ): ErrorInfo => ({
    message: error instanceof Error ? error.message : String(error),
    name: error instanceof Error ? error.name : "Error",
    segmentId,
    segmentType,
  });

  describe("successful loader", () => {
    it("should wrap successful loader result", async () => {
      const promise = Promise.resolve({ items: [1, 2, 3] });
      const entry = createEntry();

      const result = await wrapLoaderWithErrorHandling(
        promise,
        entry,
        "loader-segment",
        "/test",
        () => null,
        mockCreateErrorInfo
      );

      expect(result).toEqual({
        __loaderResult: true,
        ok: true,
        data: { items: [1, 2, 3] },
      });
    });

    it("should handle primitive return values", async () => {
      const promise = Promise.resolve(42);
      const entry = createEntry();

      const result = await wrapLoaderWithErrorHandling(
        promise,
        entry,
        "loader-segment",
        "/test",
        () => null,
        mockCreateErrorInfo
      );

      expect(result).toEqual({
        __loaderResult: true,
        ok: true,
        data: 42,
      });
    });

    it("should handle null return value", async () => {
      const promise = Promise.resolve(null);
      const entry = createEntry();

      const result = await wrapLoaderWithErrorHandling(
        promise,
        entry,
        "loader-segment",
        "/test",
        () => null,
        mockCreateErrorInfo
      );

      expect(result).toEqual({
        __loaderResult: true,
        ok: true,
        data: null,
      });
    });
  });

  describe("failed loader without error boundary", () => {
    it("should return error result without fallback", async () => {
      const promise = Promise.reject(new Error("Loader failed"));
      const entry = createEntry();

      const result = await wrapLoaderWithErrorHandling(
        promise,
        entry,
        "cart-loader",
        "/cart",
        () => null, // No error boundary
        mockCreateErrorInfo
      );

      expect(result).toEqual({
        __loaderResult: true,
        ok: false,
        error: {
          message: "Loader failed",
          name: "Error",
          segmentId: "cart-loader",
          segmentType: "loader",
        },
        fallback: null,
      });
    });

    it("should handle non-Error thrown values", async () => {
      const promise = Promise.reject("String error");
      const entry = createEntry();

      const result = await wrapLoaderWithErrorHandling(
        promise,
        entry,
        "loader-segment",
        "/test",
        () => null,
        mockCreateErrorInfo
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toBe("String error");
      }
    });
  });

  describe("failed loader with error boundary", () => {
    it("should return error result with static fallback", async () => {
      const promise = Promise.reject(new Error("Product not found"));
      const entry = createEntry();
      const fallbackElement = React.createElement("div", null, "Error fallback");

      const result = await wrapLoaderWithErrorHandling(
        promise,
        entry,
        "product-loader",
        "/products/123",
        () => fallbackElement,
        mockCreateErrorInfo
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toBe("Product not found");
        expect(result.fallback).toBe(fallbackElement);
      }
    });

    it("should call error boundary handler with error info", async () => {
      const promise = Promise.reject(new Error("Data fetch failed"));
      const entry = createEntry();
      const handlerFn = vi.fn(({ error }) =>
        React.createElement("div", null, `Error: ${error.message}`)
      );

      const result = await wrapLoaderWithErrorHandling(
        promise,
        entry,
        "data-loader",
        "/data",
        () => handlerFn,
        mockCreateErrorInfo
      );

      expect(handlerFn).toHaveBeenCalledWith({
        error: {
          message: "Data fetch failed",
          name: "Error",
          segmentId: "data-loader",
          segmentType: "loader",
        },
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.fallback).toBeDefined();
      }
    });
  });

  describe("error boundary lookup", () => {
    it("should pass entry to findNearestErrorBoundary", async () => {
      const promise = Promise.reject(new Error("Test"));
      const entry = createEntry({ id: "specific-entry" });
      const findBoundary = vi.fn(() => null);

      await wrapLoaderWithErrorHandling(
        promise,
        entry,
        "loader",
        "/test",
        findBoundary,
        mockCreateErrorInfo
      );

      expect(findBoundary).toHaveBeenCalledWith(entry);
    });
  });
});

describe("setupLoaderAccess", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("loader execution", () => {
    it("should execute loader and return promise", async () => {
      const ctx = createContext();
      const loaderPromises = new Map<string, Promise<any>>();
      const loader = createLoader("cart", async () => ({ items: [] }));

      setupLoaderAccess(ctx, loaderPromises);

      const result = await ctx.use(loader);
      expect(result).toEqual({ items: [] });
    });

    it("should memoize loader results", async () => {
      const ctx = createContext();
      const loaderPromises = new Map<string, Promise<any>>();
      const loaderFn = vi.fn(async () => ({ count: Math.random() }));
      const loader = createLoader("counter", loaderFn);

      setupLoaderAccess(ctx, loaderPromises);

      const result1 = ctx.use(loader);
      const result2 = ctx.use(loader);

      // Should return the same promise
      expect(result1).toBe(result2);

      // Function should only be called once
      expect(loaderFn).toHaveBeenCalledTimes(1);

      // Results should be identical
      expect(await result1).toEqual(await result2);
    });

    it("should pass context to loader function", async () => {
      const ctx = createContext({
        params: { slug: "test-product" },
        pathname: "/products/test-product",
      });
      const loaderPromises = new Map<string, Promise<any>>();

      let capturedCtx: any = null;
      const loader = createLoader("product", async (loaderCtx: any) => {
        capturedCtx = loaderCtx;
        return { slug: loaderCtx.params.slug };
      });

      setupLoaderAccess(ctx, loaderPromises);
      await ctx.use(loader);

      expect(capturedCtx.params).toEqual({ slug: "test-product" });
      expect(capturedCtx.pathname).toBe("/products/test-product");
    });

    it("should throw if loader has no function", () => {
      const ctx = createContext();
      const loaderPromises = new Map<string, Promise<any>>();
      const loader: LoaderDefinition<any> = {
        __brand: "loader",
        name: "broken",
        fn: undefined,
      };

      setupLoaderAccess(ctx, loaderPromises);

      expect(() => ctx.use(loader)).toThrow(
        'Loader "broken" has no function'
      );
    });
  });

  describe("loader dependencies", () => {
    it("should support loader calling another loader via ctx.use", async () => {
      const ctx = createContext();
      const loaderPromises = new Map<string, Promise<any>>();

      const userLoader = createLoader("user", async () => ({
        id: "user-123",
        name: "John",
      }));

      const cartLoader = createLoader("cart", async (loaderCtx: any) => {
        const user = await loaderCtx.use(userLoader);
        return { userId: user.id, items: [] };
      });

      setupLoaderAccess(ctx, loaderPromises);

      const cart = await ctx.use(cartLoader);
      expect(cart).toEqual({ userId: "user-123", items: [] });
    });

    it("should share memoized results across dependent loaders", async () => {
      const ctx = createContext();
      const loaderPromises = new Map<string, Promise<any>>();
      const userFn = vi.fn(async () => ({ id: "user-123" }));

      const userLoader = createLoader("user", userFn);
      const cartLoader = createLoader("cart", async (loaderCtx: any) => {
        const user = await loaderCtx.use(userLoader);
        return { userId: user.id };
      });
      const ordersLoader = createLoader("orders", async (loaderCtx: any) => {
        const user = await loaderCtx.use(userLoader);
        return { userId: user.id, orders: [] };
      });

      setupLoaderAccess(ctx, loaderPromises);

      // Both cart and orders depend on user
      await Promise.all([ctx.use(cartLoader), ctx.use(ordersLoader)]);

      // User loader should only be called once
      expect(userFn).toHaveBeenCalledTimes(1);
    });
  });

  describe("handle support", () => {
    it("should return push function for handle", () => {
      const handleStore = {
        push: vi.fn(),
      };
      const ctx = createContext({
        env: { __handleStore: handleStore },
        _currentSegmentId: "segment-1",
      });
      const loaderPromises = new Map<string, Promise<any>>();

      const handle = {
        __brand: "handle" as const,
        name: "breadcrumbs",
      };

      setupLoaderAccess(ctx, loaderPromises);

      const push = ctx.use(handle as any);
      expect(typeof push).toBe("function");
    });

    it("should push value to handle store", () => {
      const handleStore = {
        push: vi.fn(),
      };
      const ctx = createContext({
        env: { __handleStore: handleStore },
        _currentSegmentId: "product-segment",
      });
      const loaderPromises = new Map<string, Promise<any>>();

      const handle = {
        __brand: "handle" as const,
        name: "breadcrumbs",
      };

      setupLoaderAccess(ctx, loaderPromises);

      const push = ctx.use(handle as any);
      push({ label: "Product", href: "/product" });

      expect(handleStore.push).toHaveBeenCalledWith(
        "breadcrumbs",
        "product-segment",
        { label: "Product", href: "/product" }
      );
    });

    it("should handle promise values", () => {
      const handleStore = {
        push: vi.fn(),
      };
      const ctx = createContext({
        env: { __handleStore: handleStore },
        _currentSegmentId: "segment-1",
      });
      const loaderPromises = new Map<string, Promise<any>>();

      const handle = {
        __brand: "handle" as const,
        name: "meta",
      };

      setupLoaderAccess(ctx, loaderPromises);

      const push = ctx.use(handle as any);
      const promiseValue = Promise.resolve({ title: "Page Title" });
      push(promiseValue);

      expect(handleStore.push).toHaveBeenCalledWith(
        "meta",
        "segment-1",
        promiseValue
      );
    });

    it("should execute async callback and push result", () => {
      const handleStore = {
        push: vi.fn(),
      };
      const ctx = createContext({
        env: { __handleStore: handleStore },
        _currentSegmentId: "segment-1",
      });
      const loaderPromises = new Map<string, Promise<any>>();

      const handle = {
        __brand: "handle" as const,
        name: "analytics",
      };

      setupLoaderAccess(ctx, loaderPromises);

      const push = ctx.use(handle as any);
      const asyncFn = async () => ({ event: "page_view" });
      push(asyncFn);

      // Should call the function and push the resulting promise
      expect(handleStore.push).toHaveBeenCalledWith(
        "analytics",
        "segment-1",
        expect.any(Promise)
      );
    });

    it("should throw if handle used without segment ID", () => {
      const ctx = createContext({
        env: { __handleStore: { push: vi.fn() } },
        _currentSegmentId: undefined,
      });
      const loaderPromises = new Map<string, Promise<any>>();

      const handle = {
        __brand: "handle" as const,
        name: "breadcrumbs",
      };

      setupLoaderAccess(ctx, loaderPromises);

      expect(() => ctx.use(handle as any)).toThrow(
        'Handle "breadcrumbs" used outside of handler context'
      );
    });

    it("should silently skip push when no handle store", () => {
      const ctx = createContext({
        env: {}, // No __handleStore
        _currentSegmentId: "segment-1",
      });
      const loaderPromises = new Map<string, Promise<any>>();

      const handle = {
        __brand: "handle" as const,
        name: "breadcrumbs",
      };

      setupLoaderAccess(ctx, loaderPromises);

      const push = ctx.use(handle as any);
      // Should not throw
      expect(() => push({ label: "Test" })).not.toThrow();
    });
  });

  describe("error handling", () => {
    it("should propagate loader errors", async () => {
      const ctx = createContext();
      const loaderPromises = new Map<string, Promise<any>>();
      const loader = createLoader("failing", async () => {
        throw new Error("Database connection failed");
      });

      setupLoaderAccess(ctx, loaderPromises);

      await expect(ctx.use(loader)).rejects.toThrow("Database connection failed");
    });

    it("should still memoize failed loaders", async () => {
      const ctx = createContext();
      const loaderPromises = new Map<string, Promise<any>>();
      const loaderFn = vi.fn(async () => {
        throw new Error("Always fails");
      });
      const loader = createLoader("flaky", loaderFn);

      setupLoaderAccess(ctx, loaderPromises);

      // First call
      await expect(ctx.use(loader)).rejects.toThrow();

      // Second call - should use memoized (failed) promise
      await expect(ctx.use(loader)).rejects.toThrow();

      // Function should only be called once
      expect(loaderFn).toHaveBeenCalledTimes(1);
    });
  });
});

describe("revalidate", () => {
  describe("conditional execution", () => {
    it("should call onRevalidate when shouldRevalidate returns true", async () => {
      const onRevalidate = vi.fn(async () => "revalidated");
      const onSkip = vi.fn(() => "skipped");

      const result = await revalidate(
        async () => true,
        onRevalidate,
        onSkip
      );

      expect(result).toBe("revalidated");
      expect(onRevalidate).toHaveBeenCalledTimes(1);
      expect(onSkip).not.toHaveBeenCalled();
    });

    it("should call onSkip when shouldRevalidate returns false", async () => {
      const onRevalidate = vi.fn(async () => "revalidated");
      const onSkip = vi.fn(() => "skipped");

      const result = await revalidate(
        async () => false,
        onRevalidate,
        onSkip
      );

      expect(result).toBe("skipped");
      expect(onSkip).toHaveBeenCalledTimes(1);
      expect(onRevalidate).not.toHaveBeenCalled();
    });
  });

  describe("async behavior", () => {
    it("should await shouldRevalidate", async () => {
      const checkOrder: string[] = [];

      await revalidate(
        async () => {
          await new Promise((r) => setTimeout(r, 10));
          checkOrder.push("check");
          return true;
        },
        async () => {
          checkOrder.push("revalidate");
          return "done";
        },
        () => {
          checkOrder.push("skip");
          return "skipped";
        }
      );

      expect(checkOrder).toEqual(["check", "revalidate"]);
    });

    it("should await onRevalidate", async () => {
      const result = await revalidate(
        async () => true,
        async () => {
          await new Promise((r) => setTimeout(r, 10));
          return { fresh: true };
        },
        () => ({ fresh: false })
      );

      expect(result).toEqual({ fresh: true });
    });

    it("should return sync onSkip result immediately", async () => {
      const startTime = Date.now();

      const result = await revalidate(
        async () => false,
        async () => {
          await new Promise((r) => setTimeout(r, 100));
          return "slow";
        },
        () => "fast"
      );

      const elapsed = Date.now() - startTime;
      expect(result).toBe("fast");
      expect(elapsed).toBeLessThan(50); // Should be nearly instant
    });
  });

  describe("return types", () => {
    it("should preserve complex return types", async () => {
      interface SegmentData {
        id: string;
        component: string;
        params: Record<string, string>;
      }

      const result = await revalidate<SegmentData>(
        async () => true,
        async () => ({
          id: "segment-1",
          component: "ProductPage",
          params: { slug: "test" },
        }),
        () => ({
          id: "cached",
          component: "CachedPage",
          params: {},
        })
      );

      expect(result).toEqual({
        id: "segment-1",
        component: "ProductPage",
        params: { slug: "test" },
      });
    });

    it("should handle null/undefined returns", async () => {
      const result1 = await revalidate(
        async () => true,
        async () => null,
        () => undefined
      );
      expect(result1).toBeNull();

      const result2 = await revalidate(
        async () => false,
        async () => null,
        () => undefined
      );
      expect(result2).toBeUndefined();
    });
  });

  describe("error handling", () => {
    it("should propagate errors from shouldRevalidate", async () => {
      await expect(
        revalidate(
          async () => {
            throw new Error("Check failed");
          },
          async () => "ok",
          () => "ok"
        )
      ).rejects.toThrow("Check failed");
    });

    it("should propagate errors from onRevalidate", async () => {
      await expect(
        revalidate(
          async () => true,
          async () => {
            throw new Error("Revalidation failed");
          },
          () => "ok"
        )
      ).rejects.toThrow("Revalidation failed");
    });

    it("should not call onSkip if shouldRevalidate throws", async () => {
      const onSkip = vi.fn(() => "skipped");

      await expect(
        revalidate(
          async () => {
            throw new Error("Early error");
          },
          async () => "ok",
          onSkip
        )
      ).rejects.toThrow();

      expect(onSkip).not.toHaveBeenCalled();
    });
  });
});
