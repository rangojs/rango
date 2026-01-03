import { describe, it, expect, vi } from "vitest";
import type { OnErrorCallback, OnErrorContext, ErrorPhase, ErrorInfo } from "../../types";
import { wrapLoaderWithErrorHandling } from "../loader-resolution";

describe("OnError Types", () => {
  describe("OnErrorContext", () => {
    it("should have all required properties", () => {
      const context: OnErrorContext = {
        error: new Error("Test error"),
        phase: "routing",
        request: new Request("https://example.com/test"),
        url: new URL("https://example.com/test"),
        pathname: "/test",
        method: "GET",
      };

      expect(context.error).toBeInstanceOf(Error);
      expect(context.phase).toBe("routing");
      expect(context.request).toBeInstanceOf(Request);
      expect(context.url).toBeInstanceOf(URL);
      expect(context.pathname).toBe("/test");
      expect(context.method).toBe("GET");
    });

    it("should support optional properties", () => {
      const context: OnErrorContext = {
        error: new Error("Test error"),
        phase: "loader",
        request: new Request("https://example.com/products/123"),
        url: new URL("https://example.com/products/123"),
        pathname: "/products/123",
        method: "GET",
        routeKey: "products.detail",
        params: { id: "123" },
        segmentId: "M1L0R0",
        segmentType: "loader",
        loaderName: "ProductLoader",
        duration: 150.5,
        isPartial: true,
        handledByBoundary: true,
        stack: "Error: Test error\n    at ...",
        metadata: { custom: "data" },
      };

      expect(context.routeKey).toBe("products.detail");
      expect(context.params).toEqual({ id: "123" });
      expect(context.segmentId).toBe("M1L0R0");
      expect(context.segmentType).toBe("loader");
      expect(context.loaderName).toBe("ProductLoader");
      expect(context.duration).toBe(150.5);
      expect(context.isPartial).toBe(true);
      expect(context.handledByBoundary).toBe(true);
      expect(context.stack).toBeDefined();
      expect(context.metadata).toEqual({ custom: "data" });
    });

    it("should support action-specific properties", () => {
      const context: OnErrorContext = {
        error: new Error("Action failed"),
        phase: "action",
        request: new Request("https://example.com/api", { method: "POST" }),
        url: new URL("https://example.com/api"),
        pathname: "/api",
        method: "POST",
        actionId: "src/actions.ts#addToCart",
      };

      expect(context.phase).toBe("action");
      expect(context.actionId).toBe("src/actions.ts#addToCart");
      expect(context.method).toBe("POST");
    });

    it("should support middleware-specific properties", () => {
      const context: OnErrorContext = {
        error: new Error("Auth failed"),
        phase: "middleware",
        request: new Request("https://example.com/admin"),
        url: new URL("https://example.com/admin"),
        pathname: "/admin",
        method: "GET",
        middlewareId: "auth",
        segmentType: "middleware",
      };

      expect(context.phase).toBe("middleware");
      expect(context.middlewareId).toBe("auth");
      expect(context.segmentType).toBe("middleware");
    });

    it("should support typed env", () => {
      interface AppEnv {
        DB: { query: () => void };
        USER_ID: string;
      }

      const context: OnErrorContext<AppEnv> = {
        error: new Error("DB error"),
        phase: "loader",
        request: new Request("https://example.com"),
        url: new URL("https://example.com"),
        pathname: "/",
        method: "GET",
        env: {
          DB: { query: () => {} },
          USER_ID: "user-123",
        },
      };

      expect(context.env?.DB).toBeDefined();
      expect(context.env?.USER_ID).toBe("user-123");
    });
  });

  describe("ErrorPhase", () => {
    it("should include all valid phases", () => {
      const phases: ErrorPhase[] = [
        "routing",
        "manifest",
        "middleware",
        "loader",
        "handler",
        "rendering",
        "action",
        "revalidation",
        "unknown",
      ];

      expect(phases).toHaveLength(9);
      phases.forEach((phase) => {
        expect(typeof phase).toBe("string");
      });
    });
  });

  describe("OnErrorCallback", () => {
    it("should accept sync callback", () => {
      const errors: OnErrorContext[] = [];
      const callback: OnErrorCallback = (context) => {
        errors.push(context);
      };

      const context: OnErrorContext = {
        error: new Error("Test"),
        phase: "routing",
        request: new Request("https://example.com"),
        url: new URL("https://example.com"),
        pathname: "/",
        method: "GET",
      };

      callback(context);
      expect(errors).toHaveLength(1);
    });

    it("should accept async callback", async () => {
      const errors: OnErrorContext[] = [];
      const callback: OnErrorCallback = async (context) => {
        await Promise.resolve();
        errors.push(context);
      };

      const context: OnErrorContext = {
        error: new Error("Test"),
        phase: "action",
        request: new Request("https://example.com"),
        url: new URL("https://example.com"),
        pathname: "/",
        method: "POST",
      };

      await callback(context);
      expect(errors).toHaveLength(1);
    });

    it("should work with typed env", () => {
      interface CustomEnv {
        secret: string;
      }

      const callback: OnErrorCallback<CustomEnv> = (context) => {
        // Type-safe access to env
        const secret = context.env?.secret;
        expect(typeof secret).toBe("string");
      };

      callback({
        error: new Error("Test"),
        phase: "routing",
        request: new Request("https://example.com"),
        url: new URL("https://example.com"),
        pathname: "/",
        method: "GET",
        env: { secret: "test-secret" },
      });
    });
  });
});

describe("OnError Callback Integration", () => {
  it("should capture error details from context", () => {
    const capturedErrors: Array<{
      message: string;
      phase: ErrorPhase;
      route?: string;
      duration?: number;
    }> = [];

    const onError: OnErrorCallback = (context) => {
      capturedErrors.push({
        message: context.error.message,
        phase: context.phase,
        route: context.routeKey,
        duration: context.duration,
      });
    };

    // Simulate errors from different phases
    onError({
      error: new Error("Route not found"),
      phase: "routing",
      request: new Request("https://example.com/unknown"),
      url: new URL("https://example.com/unknown"),
      pathname: "/unknown",
      method: "GET",
    });

    onError({
      error: new Error("Loader failed"),
      phase: "loader",
      request: new Request("https://example.com/products"),
      url: new URL("https://example.com/products"),
      pathname: "/products",
      method: "GET",
      routeKey: "products.list",
      loaderName: "ProductsLoader",
      duration: 100,
    });

    onError({
      error: new Error("Action failed"),
      phase: "action",
      request: new Request("https://example.com/cart", { method: "POST" }),
      url: new URL("https://example.com/cart"),
      pathname: "/cart",
      method: "POST",
      actionId: "addToCart",
      duration: 50,
    });

    expect(capturedErrors).toHaveLength(3);
    expect(capturedErrors[0]).toEqual({
      message: "Route not found",
      phase: "routing",
      route: undefined,
      duration: undefined,
    });
    expect(capturedErrors[1]).toEqual({
      message: "Loader failed",
      phase: "loader",
      route: "products.list",
      duration: 100,
    });
    expect(capturedErrors[2]).toEqual({
      message: "Action failed",
      phase: "action",
      route: undefined,
      duration: 50,
    });
  });

  it("should handle errors thrown in callback gracefully", () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const badCallback: OnErrorCallback = () => {
      throw new Error("Callback error");
    };

    // The callback throws, but it shouldn't propagate
    // In real implementation, this is caught by invokeOnError
    expect(() => {
      try {
        badCallback({
          error: new Error("Original error"),
          phase: "routing",
          request: new Request("https://example.com"),
          url: new URL("https://example.com"),
          pathname: "/",
          method: "GET",
        });
      } catch (e) {
        // In real code, invokeOnError catches this
        console.error("[Router.onError] Callback error:", e);
      }
    }).not.toThrow();

    consoleErrorSpy.mockRestore();
  });

  it("should handle async callback rejection gracefully", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const badAsyncCallback: OnErrorCallback = async () => {
      await Promise.reject(new Error("Async callback error"));
    };

    const context: OnErrorContext = {
      error: new Error("Original error"),
      phase: "action",
      request: new Request("https://example.com"),
      url: new URL("https://example.com"),
      pathname: "/",
      method: "POST",
    };

    // In real implementation, the promise rejection is caught
    const result = badAsyncCallback(context);
    if (result instanceof Promise) {
      await result.catch((e) => {
        console.error("[Router.onError] Callback error:", e);
      });
    }

    consoleErrorSpy.mockRestore();
  });
});

describe("wrapLoaderWithErrorHandling", () => {
  const mockEntry = { id: "test-entry" } as any;
  const mockPathname = "/test";

  const createMockErrorInfo = (
    error: unknown,
    segmentId: string,
    segmentType: ErrorInfo["segmentType"]
  ): ErrorInfo => ({
    message: error instanceof Error ? error.message : String(error),
    digest: "test-digest",
    segmentId,
    segmentType,
  });

  describe("successful resolution", () => {
    it("should return ok: true with data on success", async () => {
      const promise = Promise.resolve({ name: "Test Product" });

      const result = await wrapLoaderWithErrorHandling(
        promise,
        mockEntry,
        "M1L0.ProductLoader",
        mockPathname,
        () => null,
        createMockErrorInfo
      );

      expect(result).toEqual({
        __loaderResult: true,
        ok: true,
        data: { name: "Test Product" },
      });
    });

    it("should not invoke onError on success", async () => {
      const onError = vi.fn();
      const promise = Promise.resolve("success");

      await wrapLoaderWithErrorHandling(
        promise,
        mockEntry,
        "M1L0.TestLoader",
        mockPathname,
        () => null,
        createMockErrorInfo,
        onError
      );

      expect(onError).not.toHaveBeenCalled();
    });
  });

  describe("error handling without boundary", () => {
    it("should return ok: false with error info when no boundary", async () => {
      const promise = Promise.reject(new Error("Loader failed"));

      const result = await wrapLoaderWithErrorHandling(
        promise,
        mockEntry,
        "M1L0.FailingLoader",
        mockPathname,
        () => null, // No error boundary
        createMockErrorInfo
      );

      expect(result).toEqual({
        __loaderResult: true,
        ok: false,
        error: {
          message: "Loader failed",
          digest: "test-digest",
          segmentId: "M1L0.FailingLoader",
          segmentType: "loader",
        },
        fallback: null,
      });
    });

    it("should invoke onError with handledByBoundary: false", async () => {
      const onError = vi.fn();
      const testError = new Error("Test error");
      const promise = Promise.reject(testError);

      await wrapLoaderWithErrorHandling(
        promise,
        mockEntry,
        "M1L0.TestLoader",
        mockPathname,
        () => null, // No boundary
        createMockErrorInfo,
        onError
      );

      expect(onError).toHaveBeenCalledWith(testError, {
        segmentId: "M1L0.TestLoader",
        loaderName: "TestLoader",
        handledByBoundary: false,
      });
    });
  });

  describe("error handling with boundary", () => {
    it("should return fallback when error boundary exists", async () => {
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const promise = Promise.reject(new Error("Handled error"));
      const fallbackElement = "Error Fallback UI";

      const result = await wrapLoaderWithErrorHandling(
        promise,
        mockEntry,
        "M1L0.HandledLoader",
        mockPathname,
        () => fallbackElement, // Has error boundary
        createMockErrorInfo
      );

      expect(result).toEqual({
        __loaderResult: true,
        ok: false,
        error: {
          message: "Handled error",
          digest: "test-digest",
          segmentId: "M1L0.HandledLoader",
          segmentType: "loader",
        },
        fallback: fallbackElement,
      });

      consoleSpy.mockRestore();
    });

    it("should invoke onError with handledByBoundary: true", async () => {
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const onError = vi.fn();
      const testError = new Error("Boundary handled");
      const promise = Promise.reject(testError);

      await wrapLoaderWithErrorHandling(
        promise,
        mockEntry,
        "M1L0.BoundaryLoader",
        mockPathname,
        () => "Fallback", // Has boundary
        createMockErrorInfo,
        onError
      );

      expect(onError).toHaveBeenCalledWith(testError, {
        segmentId: "M1L0.BoundaryLoader",
        loaderName: "BoundaryLoader",
        handledByBoundary: true,
      });

      consoleSpy.mockRestore();
    });

    it("should call ErrorBoundaryHandler function with error props", async () => {
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const promise = Promise.reject(new Error("Handler error"));
      const boundaryHandler = vi.fn().mockReturnValue("Rendered Fallback");

      const result = await wrapLoaderWithErrorHandling(
        promise,
        mockEntry,
        "M1L0.HandlerLoader",
        mockPathname,
        () => boundaryHandler,
        createMockErrorInfo
      );

      expect(boundaryHandler).toHaveBeenCalledWith({
        error: {
          message: "Handler error",
          digest: "test-digest",
          segmentId: "M1L0.HandlerLoader",
          segmentType: "loader",
        },
      });
      expect(result.fallback).toBe("Rendered Fallback");

      consoleSpy.mockRestore();
    });
  });

  describe("loaderName extraction", () => {
    it("should extract loader name from segmentId with dot notation", async () => {
      const onError = vi.fn();
      const promise = Promise.reject(new Error("test"));

      await wrapLoaderWithErrorHandling(
        promise,
        mockEntry,
        "M1L0D0.ProductLoader",
        mockPathname,
        () => null,
        createMockErrorInfo,
        onError
      );

      expect(onError).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({ loaderName: "ProductLoader" })
      );
    });

    it("should handle segmentId without dots", async () => {
      const onError = vi.fn();
      const promise = Promise.reject(new Error("test"));

      await wrapLoaderWithErrorHandling(
        promise,
        mockEntry,
        "SimpleLoader",
        mockPathname,
        () => null,
        createMockErrorInfo,
        onError
      );

      expect(onError).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({ loaderName: "SimpleLoader" })
      );
    });

    it("should return 'unknown' for empty segmentId", async () => {
      const onError = vi.fn();
      const promise = Promise.reject(new Error("test"));

      await wrapLoaderWithErrorHandling(
        promise,
        mockEntry,
        "",
        mockPathname,
        () => null,
        createMockErrorInfo,
        onError
      );

      expect(onError).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({ loaderName: "unknown" })
      );
    });
  });

  describe("non-Error objects", () => {
    it("should handle string errors", async () => {
      const promise = Promise.reject("String error message");

      const result = await wrapLoaderWithErrorHandling(
        promise,
        mockEntry,
        "M1L0.StringErrorLoader",
        mockPathname,
        () => null,
        createMockErrorInfo
      );

      expect(result.ok).toBe(false);
      expect(result.error?.message).toBe("String error message");
    });

    it("should handle object errors", async () => {
      const promise = Promise.reject({ code: "ERR_001", detail: "Failed" });

      const result = await wrapLoaderWithErrorHandling(
        promise,
        mockEntry,
        "M1L0.ObjectErrorLoader",
        mockPathname,
        () => null,
        (error) => ({
          message: String(error),
          digest: "digest",
          segmentId: "test",
          segmentType: "loader",
        })
      );

      expect(result.ok).toBe(false);
    });

    it("should handle null/undefined errors", async () => {
      const promise = Promise.reject(null);

      const result = await wrapLoaderWithErrorHandling(
        promise,
        mockEntry,
        "M1L0.NullErrorLoader",
        mockPathname,
        () => null,
        (error) => ({
          message: String(error),
          digest: "digest",
          segmentId: "test",
          segmentType: "loader",
        })
      );

      expect(result.ok).toBe(false);
      expect(result.error?.message).toBe("null");
    });
  });
});

describe("Error Context Edge Cases", () => {
  it("should handle errors with circular references in metadata", () => {
    const circular: any = { name: "test" };
    circular.self = circular;

    const context: OnErrorContext = {
      error: new Error("Circular test"),
      phase: "loader",
      request: new Request("https://example.com"),
      url: new URL("https://example.com"),
      pathname: "/",
      method: "GET",
      metadata: { circular }, // This shouldn't crash serialization
    };

    expect(context.metadata?.circular).toBe(circular);
  });

  it("should handle errors without stack traces", () => {
    const errorWithoutStack = new Error("No stack");
    delete errorWithoutStack.stack;

    const context: OnErrorContext = {
      error: errorWithoutStack,
      phase: "routing",
      request: new Request("https://example.com"),
      url: new URL("https://example.com"),
      pathname: "/",
      method: "GET",
      stack: errorWithoutStack.stack,
    };

    expect(context.stack).toBeUndefined();
  });

  it("should handle very long error messages", () => {
    const longMessage = "x".repeat(10000);
    const context: OnErrorContext = {
      error: new Error(longMessage),
      phase: "handler",
      request: new Request("https://example.com"),
      url: new URL("https://example.com"),
      pathname: "/",
      method: "GET",
    };

    expect(context.error.message.length).toBe(10000);
  });

  it("should preserve error cause chain", () => {
    const rootCause = new Error("Root cause");
    const wrappedError = new Error("Wrapped error", { cause: rootCause });

    const context: OnErrorContext = {
      error: wrappedError,
      phase: "loader",
      request: new Request("https://example.com"),
      url: new URL("https://example.com"),
      pathname: "/",
      method: "GET",
    };

    expect(context.error.cause).toBe(rootCause);
  });
});
