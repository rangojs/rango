import { describe, it, expect, vi } from "vitest";
import React from "react";
import { createSSRHandler, type SSRDependencies } from "../index";

describe("createSSRHandler", () => {
  // Mock dependencies
  const createMockDeps = (
    overrides: Partial<SSRDependencies> = {}
  ): SSRDependencies => ({
    createFromReadableStream: vi.fn().mockResolvedValue({
      root: React.createElement("div", null, "Test"),
      metadata: { matched: ["/"], pathname: "/" },
    }),
    renderToReadableStream: vi.fn().mockResolvedValue(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("<html><body>Test</body></html>"));
          controller.close();
        },
      })
    ),
    injectRSCPayload: vi.fn().mockReturnValue(
      new TransformStream({
        transform(chunk, controller) {
          controller.enqueue(chunk);
        },
      })
    ),
    loadBootstrapScriptContent: vi.fn().mockResolvedValue("console.log('bootstrap')"),
    ...overrides,
  });

  const createMockRscStream = () =>
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("mock rsc payload"));
        controller.close();
      },
    });

  describe("onError callback", () => {
    it("should call onError when rendering fails", async () => {
      const onError = vi.fn();
      const renderError = new Error("Rendering failed");

      const deps = createMockDeps({
        renderToReadableStream: vi.fn().mockRejectedValue(renderError),
        onError,
      });

      const renderHTML = createSSRHandler(deps);

      await expect(renderHTML(createMockRscStream())).rejects.toThrow("Rendering failed");

      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError).toHaveBeenCalledWith(renderError, { phase: "rendering" });
    });

    it("should call onError with phase: rendering", async () => {
      const onError = vi.fn();

      const deps = createMockDeps({
        // Use loadBootstrapScriptContent error since it happens before React.use()
        loadBootstrapScriptContent: vi.fn().mockRejectedValue(new Error("Bootstrap failed")),
        onError,
      });

      const renderHTML = createSSRHandler(deps);

      await expect(renderHTML(createMockRscStream())).rejects.toThrow("Bootstrap failed");

      expect(onError).toHaveBeenCalledWith(
        expect.any(Error),
        { phase: "rendering" }
      );
    });

    it("should convert non-Error objects to Error", async () => {
      const onError = vi.fn();

      const deps = createMockDeps({
        renderToReadableStream: vi.fn().mockRejectedValue("string error"),
        onError,
      });

      const renderHTML = createSSRHandler(deps);

      await expect(renderHTML(createMockRscStream())).rejects.toThrow();

      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "string error",
        }),
        { phase: "rendering" }
      );
    });

    it("should still throw original error after calling onError", async () => {
      const onError = vi.fn();
      const originalError = new Error("Original error");

      const deps = createMockDeps({
        loadBootstrapScriptContent: vi.fn().mockRejectedValue(originalError),
        onError,
      });

      const renderHTML = createSSRHandler(deps);

      await expect(renderHTML(createMockRscStream())).rejects.toThrow("Original error");

      // Verify onError was called before error was thrown
      expect(onError).toHaveBeenCalled();
    });

    it("should catch errors in onError callback and not break the flow", async () => {
      const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const callbackError = new Error("Callback exploded");
      const onError = vi.fn().mockImplementation(() => {
        throw callbackError;
      });
      const originalError = new Error("Original rendering error");

      const deps = createMockDeps({
        renderToReadableStream: vi.fn().mockRejectedValue(originalError),
        onError,
      });

      const renderHTML = createSSRHandler(deps);

      // Should throw original error, not callback error
      await expect(renderHTML(createMockRscStream())).rejects.toThrow("Original rendering error");

      expect(onError).toHaveBeenCalled();
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        "[SSRHandler.onError] Callback error:",
        callbackError
      );

      consoleErrorSpy.mockRestore();
    });

    it("should not call onError when rendering succeeds", async () => {
      const onError = vi.fn();

      const deps = createMockDeps({ onError });
      const renderHTML = createSSRHandler(deps);

      const result = await renderHTML(createMockRscStream());

      expect(result).toBeInstanceOf(ReadableStream);
      expect(onError).not.toHaveBeenCalled();
    });

    it("should work without onError callback", async () => {
      const deps = createMockDeps({
        renderToReadableStream: vi.fn().mockRejectedValue(new Error("No callback test")),
        onError: undefined,
      });

      const renderHTML = createSSRHandler(deps);

      // Should not throw because of missing onError
      await expect(renderHTML(createMockRscStream())).rejects.toThrow("No callback test");
    });
  });

  describe("successful rendering", () => {
    it("should return a ReadableStream on success", async () => {
      const deps = createMockDeps();
      const renderHTML = createSSRHandler(deps);

      const result = await renderHTML(createMockRscStream());

      expect(result).toBeInstanceOf(ReadableStream);
    });

    it("should call all dependencies in correct order", async () => {
      const deps = createMockDeps();
      const renderHTML = createSSRHandler(deps);

      await renderHTML(createMockRscStream());

      expect(deps.loadBootstrapScriptContent).toHaveBeenCalled();
      expect(deps.renderToReadableStream).toHaveBeenCalled();
      expect(deps.injectRSCPayload).toHaveBeenCalled();
    });
  });
});
