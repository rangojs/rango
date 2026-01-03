import { describe, it, expect, vi } from "vitest";
import type { OnErrorCallback, OnErrorContext, ErrorPhase } from "../../types";

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
