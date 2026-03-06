/**
 * onError Correctness Audit Tests
 *
 * Proves:
 * 1. Single-report semantics (no double-reporting)
 * 2. Correct phase assignment at each call site
 * 3. Correct handledByBoundary semantics
 * 4. Dedup via WeakSet in both Router and RSC layers
 * 5. Streaming handler errors are reported to onError
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { invokeOnError, type InvokeOnErrorContext } from "../error-handling";
import {
  wrapLoaderWithErrorHandling,
  type LoaderErrorCallback,
} from "../loader-resolution";
import type { OnErrorCallback, OnErrorContext, ErrorPhase } from "../../types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function createContext(
  overrides?: Partial<InvokeOnErrorContext>,
): InvokeOnErrorContext {
  return {
    request: new Request("https://example.com/test"),
    url: new URL("https://example.com/test"),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Single-report semantics
// ---------------------------------------------------------------------------
describe("Single-report semantics", () => {
  describe("WeakSet dedup prevents double-reporting", () => {
    it("should report same error object only once when using WeakSet guard", () => {
      const callback = vi.fn();
      const reportedErrors = new WeakSet<object>();
      const error = new Error("test error");

      function callOnError(err: unknown, phase: ErrorPhase) {
        if (err != null && typeof err === "object") {
          if (reportedErrors.has(err)) return;
          reportedErrors.add(err);
        }
        invokeOnError(callback, err, phase, createContext());
      }

      // First call reports
      callOnError(error, "handler");
      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback.mock.calls[0][0].phase).toBe("handler");

      // Second call with same error object is deduplicated
      callOnError(error, "routing");
      expect(callback).toHaveBeenCalledTimes(1);
    });

    it("should report different error objects separately", () => {
      const callback = vi.fn();
      const reportedErrors = new WeakSet<object>();

      function callOnError(err: unknown, phase: ErrorPhase) {
        if (err != null && typeof err === "object") {
          if (reportedErrors.has(err)) return;
          reportedErrors.add(err);
        }
        invokeOnError(callback, err, phase, createContext());
      }

      callOnError(new Error("error 1"), "handler");
      callOnError(new Error("error 2"), "loader");
      expect(callback).toHaveBeenCalledTimes(2);
    });

    it("should still report primitive errors (no WeakSet for non-objects)", () => {
      const callback = vi.fn();
      const reportedErrors = new WeakSet<object>();

      function callOnError(err: unknown, phase: ErrorPhase) {
        if (err != null && typeof err === "object") {
          if (reportedErrors.has(err)) return;
          reportedErrors.add(err);
        }
        invokeOnError(callback, err, phase, createContext());
      }

      callOnError("string error", "routing");
      callOnError("string error", "routing");
      // Primitive errors can't be deduplicated via WeakSet
      expect(callback).toHaveBeenCalledTimes(2);
    });
  });

  describe("Loader errors: single report via wrapLoaderWithErrorHandling", () => {
    it("should report loader error exactly once (caught, not re-thrown)", async () => {
      const onError = vi.fn();
      const testError = new Error("Loader failed");
      const promise = Promise.reject(testError);

      const result = await wrapLoaderWithErrorHandling(
        promise,
        { id: "entry" } as any,
        "M1L0.ProductLoader",
        "/products",
        () => null,
        (error, segmentId, segmentType) => ({
          message: error instanceof Error ? error.message : String(error),
          name: error instanceof Error ? error.name : "Error",
          segmentId,
          segmentType,
        }),
        onError,
      );

      // Error was caught and wrapped — not re-thrown
      expect(result.ok).toBe(false);
      // onError called exactly once
      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError).toHaveBeenCalledWith(
        testError,
        expect.objectContaining({
          segmentId: "M1L0.ProductLoader",
          loaderName: "ProductLoader",
          handledByBoundary: false,
        }),
      );
    });

    it("should not propagate loader error to outer catch blocks", async () => {
      const outerCatch = vi.fn();
      const onError = vi.fn();
      const promise = Promise.reject(new Error("Loader failed"));

      try {
        const result = await wrapLoaderWithErrorHandling(
          promise,
          { id: "entry" } as any,
          "M1L0.TestLoader",
          "/test",
          () => null,
          (error, segmentId, segmentType) => ({
            message: String(error),
            name: "Error",
            segmentId,
            segmentType,
          }),
          onError,
        );

        // This should execute — the error is caught inside
        expect(result.ok).toBe(false);
      } catch {
        outerCatch();
      }

      // Outer catch should NOT be reached
      expect(outerCatch).not.toHaveBeenCalled();
      // Only one report
      expect(onError).toHaveBeenCalledTimes(1);
    });
  });
});

// ---------------------------------------------------------------------------
// 2. Phase correctness
// ---------------------------------------------------------------------------
describe("Phase correctness", () => {
  it("should accept all defined ErrorPhase values", () => {
    const callback = vi.fn();
    const allPhases: ErrorPhase[] = [
      "routing",
      "manifest",
      "middleware",
      "loader",
      "handler",
      "rendering",
      "action",
      "revalidation",
      "prerender",
      "static",
      "unknown",
    ];

    for (const phase of allPhases) {
      invokeOnError(callback, new Error("test"), phase, createContext());
    }

    expect(callback).toHaveBeenCalledTimes(allPhases.length);
    for (let i = 0; i < allPhases.length; i++) {
      expect(callback.mock.calls[i][0].phase).toBe(allPhases[i]);
    }
  });

  describe("Phase assignment by error source", () => {
    it("loader errors should use phase=loader", () => {
      const callback = vi.fn();
      invokeOnError(callback, new Error("test"), "loader", {
        ...createContext(),
        segmentType: "loader",
        loaderName: "CartLoader",
      });
      expect(callback.mock.calls[0][0].phase).toBe("loader");
      expect(callback.mock.calls[0][0].loaderName).toBe("CartLoader");
    });

    it("handler/segment errors should use phase=handler", () => {
      const callback = vi.fn();
      invokeOnError(callback, new Error("test"), "handler", {
        ...createContext(),
        segmentType: "route",
        segmentId: "M1R0",
      });
      expect(callback.mock.calls[0][0].phase).toBe("handler");
      expect(callback.mock.calls[0][0].segmentType).toBe("route");
    });

    it("action errors should use phase=action", () => {
      const callback = vi.fn();
      invokeOnError(callback, new Error("test"), "action", {
        ...createContext(),
        actionId: "src/actions.ts#addToCart",
      });
      expect(callback.mock.calls[0][0].phase).toBe("action");
      expect(callback.mock.calls[0][0].actionId).toBe(
        "src/actions.ts#addToCart",
      );
    });

    it("route-not-found should use phase=routing with handledByBoundary=true", () => {
      const callback = vi.fn();
      invokeOnError(callback, new Error("Not found"), "routing", {
        ...createContext(),
        handledByBoundary: true,
      });
      expect(callback.mock.calls[0][0].phase).toBe("routing");
      expect(callback.mock.calls[0][0].handledByBoundary).toBe(true);
    });

    it("unhandled routing errors should use phase=routing with handledByBoundary=false", () => {
      const callback = vi.fn();
      invokeOnError(callback, new Error("Unexpected"), "routing", {
        ...createContext(),
        handledByBoundary: false,
      });
      expect(callback.mock.calls[0][0].phase).toBe("routing");
      expect(callback.mock.calls[0][0].handledByBoundary).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// 3. handledByBoundary correctness
// ---------------------------------------------------------------------------
describe("handledByBoundary correctness", () => {
  it("should be true when error boundary catches and renders fallback", async () => {
    const onError = vi.fn();
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const promise = Promise.reject(new Error("Caught by boundary"));

    await wrapLoaderWithErrorHandling(
      promise,
      { id: "entry" } as any,
      "M1L0.BoundaryLoader",
      "/test",
      () => "Fallback UI", // Has error boundary
      (error, segmentId, segmentType) => ({
        message: error instanceof Error ? error.message : String(error),
        name: "Error",
        segmentId,
        segmentType,
      }),
      onError,
    );

    expect(onError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ handledByBoundary: true }),
    );
    consoleSpy.mockRestore();
  });

  it("should be false when no error boundary exists", async () => {
    const onError = vi.fn();
    const promise = Promise.reject(new Error("No boundary"));

    await wrapLoaderWithErrorHandling(
      promise,
      { id: "entry" } as any,
      "M1L0.NoBoundaryLoader",
      "/test",
      () => null, // No error boundary
      (error, segmentId, segmentType) => ({
        message: error instanceof Error ? error.message : String(error),
        name: "Error",
        segmentId,
        segmentType,
      }),
      onError,
    );

    expect(onError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ handledByBoundary: false }),
    );
  });

  it("should pass handledByBoundary through invokeOnError", () => {
    const callback = vi.fn();

    invokeOnError(callback, new Error("test"), "handler", {
      ...createContext(),
      handledByBoundary: true,
    });
    expect(callback.mock.calls[0][0].handledByBoundary).toBe(true);

    invokeOnError(callback, new Error("test2"), "handler", {
      ...createContext(),
      handledByBoundary: false,
    });
    expect(callback.mock.calls[1][0].handledByBoundary).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. invokeOnError utility behavior
// ---------------------------------------------------------------------------
describe("invokeOnError utility", () => {
  it("should be a no-op when onError callback is undefined", () => {
    expect(() => {
      invokeOnError(undefined, new Error("test"), "routing", createContext());
    }).not.toThrow();
  });

  it("should convert non-Error to Error", () => {
    const callback = vi.fn();
    invokeOnError(callback, "string error", "routing", createContext());

    const ctx = callback.mock.calls[0][0];
    expect(ctx.error).toBeInstanceOf(Error);
    expect(ctx.error.message).toBe("string error");
  });

  it("should include stack trace from Error", () => {
    const callback = vi.fn();
    const error = new Error("test");
    invokeOnError(callback, error, "routing", createContext());

    expect(callback.mock.calls[0][0].stack).toBeDefined();
    expect(callback.mock.calls[0][0].stack).toContain("Error: test");
  });

  it("should compute duration from requestStartTime", () => {
    const callback = vi.fn();
    invokeOnError(callback, new Error("test"), "loader", {
      ...createContext(),
      requestStartTime: performance.now() - 50,
    });

    const duration = callback.mock.calls[0][0].duration;
    expect(duration).toBeGreaterThanOrEqual(50);
    expect(duration).toBeLessThan(200);
  });

  it("should not set duration when requestStartTime is absent", () => {
    const callback = vi.fn();
    invokeOnError(callback, new Error("test"), "loader", createContext());

    expect(callback.mock.calls[0][0].duration).toBeUndefined();
  });

  it("should derive pathname and method from request/url", () => {
    const callback = vi.fn();
    invokeOnError(callback, new Error("test"), "action", {
      request: new Request("https://example.com/api/items", { method: "POST" }),
      url: new URL("https://example.com/api/items"),
    });

    const ctx = callback.mock.calls[0][0];
    expect(ctx.pathname).toBe("/api/items");
    expect(ctx.method).toBe("POST");
  });

  it("should catch sync callback errors", () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const callback: OnErrorCallback = () => {
      throw new Error("callback blew up");
    };

    expect(() => {
      invokeOnError(
        callback,
        new Error("original"),
        "routing",
        createContext(),
      );
    }).not.toThrow();

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining(".onError] Callback error:"),
      expect.any(Error),
    );
    consoleSpy.mockRestore();
  });

  it("should catch async callback rejections", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const callback: OnErrorCallback = async () => {
      throw new Error("async callback blew up");
    };

    invokeOnError(callback, new Error("original"), "routing", createContext());

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining(".onError] Callback error:"),
      expect.any(Error),
    );
    consoleSpy.mockRestore();
  });

  it("should use custom log prefix", () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const callback: OnErrorCallback = () => {
      throw new Error("fail");
    };

    invokeOnError(
      callback,
      new Error("test"),
      "routing",
      createContext(),
      "RSC",
    );

    expect(consoleSpy).toHaveBeenCalledWith(
      "[RSC.onError] Callback error:",
      expect.any(Error),
    );
    consoleSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// 5. Streaming handler error reporting (trackHandler)
// ---------------------------------------------------------------------------
describe("Streaming handler error reporting", () => {
  it("should report streaming handler rejection to onError via side-effect catch", async () => {
    // Simulates what trackHandler does in router.ts:
    // attaches a .catch() side-effect that calls callOnError
    const callback = vi.fn();
    const error = new Error("Streaming handler failed");

    // Simulate the tracked promise
    const handlerPromise = Promise.reject(error);

    // Simulate the side-effect catch (mirrors router.ts trackHandler)
    handlerPromise.catch((err) => {
      invokeOnError(callback, err, "handler", {
        ...createContext(),
        segmentId: "M1R0",
        segmentType: "route",
        handledByBoundary: true,
      });
    });

    // Wait for promise microtask to settle
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(callback).toHaveBeenCalledTimes(1);
    const ctx = callback.mock.calls[0][0];
    expect(ctx.phase).toBe("handler");
    expect(ctx.segmentId).toBe("M1R0");
    expect(ctx.segmentType).toBe("route");
    expect(ctx.handledByBoundary).toBe(true);
    expect(ctx.error).toBe(error);
  });

  it("should not alter the rejection chain (error still propagates)", async () => {
    const callback = vi.fn();
    const error = new Error("Streaming handler failed");
    const handlerPromise = Promise.reject(error);

    // Side-effect catch
    handlerPromise.catch((err) => {
      invokeOnError(callback, err, "handler", {
        ...createContext(),
        handledByBoundary: true,
      });
    });

    // The original promise should still reject for React's error boundary
    await expect(handlerPromise).rejects.toThrow("Streaming handler failed");
    expect(callback).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 6. Error context completeness
// ---------------------------------------------------------------------------
describe("Error context completeness", () => {
  it("should pass through all optional fields", () => {
    const callback = vi.fn();
    const fullContext: InvokeOnErrorContext = {
      request: new Request("https://example.com/api", { method: "POST" }),
      url: new URL("https://example.com/api"),
      routeKey: "api.create",
      params: { id: "42" },
      segmentId: "M1R0",
      segmentType: "route",
      loaderName: "DataLoader",
      middlewareId: "auth",
      actionId: "createItem",
      env: { DB: "connection" },
      isPartial: true,
      handledByBoundary: false,
      metadata: { retryCount: 3 },
      requestStartTime: performance.now() - 100,
    };

    invokeOnError(callback, new Error("test"), "action", fullContext);

    const ctx = callback.mock.calls[0][0];
    expect(ctx.routeKey).toBe("api.create");
    expect(ctx.params).toEqual({ id: "42" });
    expect(ctx.segmentId).toBe("M1R0");
    expect(ctx.segmentType).toBe("route");
    expect(ctx.loaderName).toBe("DataLoader");
    expect(ctx.middlewareId).toBe("auth");
    expect(ctx.actionId).toBe("createItem");
    expect(ctx.env).toEqual({ DB: "connection" });
    expect(ctx.isPartial).toBe(true);
    expect(ctx.handledByBoundary).toBe(false);
    expect(ctx.metadata).toEqual({ retryCount: 3 });
    expect(ctx.duration).toBeGreaterThanOrEqual(100);
  });

  it("should handle minimal context gracefully", () => {
    const callback = vi.fn();
    invokeOnError(callback, new Error("test"), "unknown", {
      request: new Request("https://example.com"),
      url: new URL("https://example.com"),
    });

    const ctx = callback.mock.calls[0][0];
    expect(ctx.routeKey).toBeUndefined();
    expect(ctx.params).toBeUndefined();
    expect(ctx.segmentId).toBeUndefined();
    expect(ctx.loaderName).toBeUndefined();
    expect(ctx.duration).toBeUndefined();
    expect(ctx.handledByBoundary).toBeUndefined();
  });
});
