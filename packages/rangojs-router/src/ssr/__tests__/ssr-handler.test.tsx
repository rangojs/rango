import { describe, it, expect, vi, afterEach } from "vitest";
import React, { useContext } from "react";
import { createSSRHandler, type SSRDependencies } from "../index";
import { NavigationStoreContext } from "../../browser/react/context.js";
import type { NavigationStoreContextValue } from "../../browser/react/context.js";

// Mock renderSegments so SsrRoot can render without the full segment system.
// The mock is module-level so vitest hoists it before imports.
// Existing tests that mock renderToReadableStream never invoke SsrRoot,
// so renderSegments is never called in those tests — no behavior change.
vi.mock("../../segment-system.js", () => ({
  renderSegments: vi.fn(() => Promise.resolve(React.createElement("div"))),
}));

import { renderSegments } from "../../segment-system.js";
import { renderToReadableStream as realRenderToReadableStream } from "react-dom/server";

const mockedRenderSegments = vi.mocked(renderSegments);

describe("createSSRHandler", () => {
  // Mock dependencies
  const createMockDeps = (
    overrides: Partial<SSRDependencies> = {},
  ): SSRDependencies => ({
    createFromReadableStream: vi.fn().mockResolvedValue({
      root: React.createElement("div", null, "Test"),
      metadata: { matched: ["/"], pathname: "/" },
    }),
    renderToReadableStream: vi.fn().mockResolvedValue(
      new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode("<html><body>Test</body></html>"),
          );
          controller.close();
        },
      }),
    ),
    injectRSCPayload: vi.fn().mockReturnValue(
      new TransformStream({
        transform(chunk, controller) {
          controller.enqueue(chunk);
        },
      }),
    ),
    loadBootstrapScriptContent: vi
      .fn()
      .mockResolvedValue("console.log('bootstrap')"),
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

      await expect(renderHTML(createMockRscStream())).rejects.toThrow(
        "Rendering failed",
      );

      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError).toHaveBeenCalledWith(renderError, { phase: "rendering" });
    });

    it("should call onError with phase: rendering", async () => {
      const onError = vi.fn();

      const deps = createMockDeps({
        // Use loadBootstrapScriptContent error since it happens before React.use()
        loadBootstrapScriptContent: vi
          .fn()
          .mockRejectedValue(new Error("Bootstrap failed")),
        onError,
      });

      const renderHTML = createSSRHandler(deps);

      await expect(renderHTML(createMockRscStream())).rejects.toThrow(
        "Bootstrap failed",
      );

      expect(onError).toHaveBeenCalledWith(expect.any(Error), {
        phase: "rendering",
      });
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
        { phase: "rendering" },
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

      await expect(renderHTML(createMockRscStream())).rejects.toThrow(
        "Original error",
      );

      // Verify onError was called before error was thrown
      expect(onError).toHaveBeenCalled();
    });

    it("should catch errors in onError callback and not break the flow", async () => {
      const consoleErrorSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});
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
      await expect(renderHTML(createMockRscStream())).rejects.toThrow(
        "Original rendering error",
      );

      expect(onError).toHaveBeenCalled();
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        "[SSRHandler.onError] Callback error:",
        callbackError,
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
        renderToReadableStream: vi
          .fn()
          .mockRejectedValue(new Error("No callback test")),
        onError: undefined,
      });

      const renderHTML = createSSRHandler(deps);

      // Should not throw because of missing onError
      await expect(renderHTML(createMockRscStream())).rejects.toThrow(
        "No callback test",
      );
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

  // These tests use the real renderToReadableStream so that SsrRoot actually
  // renders. This exercises createSsrEventController, consumeAsyncGenerator,
  // and NavigationStoreContext wiring — code paths that the mocked renderer
  // above never reaches.
  describe("SSR data flow", () => {
    afterEach(() => {
      mockedRenderSegments.mockReset();
      // Restore default so other tests are unaffected
      mockedRenderSegments.mockImplementation(() =>
        Promise.resolve(React.createElement("div")),
      );
    });

    async function consumeStream(
      stream: ReadableStream<Uint8Array>,
    ): Promise<string> {
      const reader = stream.getReader();
      const chunks: Uint8Array[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
      const combined = new Uint8Array(
        chunks.reduce((sum, c) => sum + c.length, 0),
      );
      let offset = 0;
      for (const chunk of chunks) {
        combined.set(chunk, offset);
        offset += chunk.length;
      }
      return new TextDecoder().decode(combined);
    }

    async function* makeHandles(
      data: Record<string, Record<string, unknown[]>>,
    ) {
      yield data;
    }

    function createRealDeps(
      overrides: Partial<SSRDependencies> = {},
    ): SSRDependencies {
      return {
        createFromReadableStream: vi.fn().mockResolvedValue({
          metadata: {
            pathname: "/",
            params: {},
            matched: ["/"],
            segments: [],
          },
        }),
        renderToReadableStream: realRenderToReadableStream as any,
        injectRSCPayload: vi.fn().mockReturnValue(
          new TransformStream({
            transform(chunk, controller) {
              controller.enqueue(chunk);
            },
          }),
        ),
        loadBootstrapScriptContent: vi.fn().mockResolvedValue(""),
        ...overrides,
      };
    }

    it("provides NavigationStoreContext with request-local pathname and params", async () => {
      let captured: NavigationStoreContextValue | null = null;

      function ContextReader() {
        captured = useContext(NavigationStoreContext);
        return React.createElement("div", null, "ok");
      }

      mockedRenderSegments.mockImplementation(() =>
        Promise.resolve(React.createElement(ContextReader)),
      );

      const deps = createRealDeps({
        createFromReadableStream: vi.fn().mockResolvedValue({
          metadata: {
            pathname: "/users/42",
            params: { id: "42" },
            matched: ["/users/42"],
            segments: [],
          },
        }),
      });

      const renderHTML = createSSRHandler(deps);
      const stream = await renderHTML(createMockRscStream());
      await consumeStream(stream);

      expect(captured).not.toBeNull();
      expect(captured!.eventController.getLocation().pathname).toBe(
        "/users/42",
      );
      expect(captured!.eventController.getParams()).toEqual({ id: "42" });
    });

    it("consumes async handle generator and passes data to event controller", async () => {
      let captured: NavigationStoreContextValue | null = null;

      function ContextReader() {
        captured = useContext(NavigationStoreContext);
        return React.createElement("div", null, "ok");
      }

      mockedRenderSegments.mockImplementation(() =>
        Promise.resolve(React.createElement(ContextReader)),
      );

      const handleData = { meta: { title: ["Test Page"] } };

      const deps = createRealDeps({
        createFromReadableStream: vi.fn().mockResolvedValue({
          metadata: {
            pathname: "/test",
            params: {},
            matched: ["/test"],
            segments: [],
            handles: makeHandles(handleData),
          },
        }),
      });

      const renderHTML = createSSRHandler(deps);
      const stream = await renderHTML(createMockRscStream());
      await consumeStream(stream);

      expect(captured).not.toBeNull();
      expect(captured!.eventController.getHandleState().data).toEqual(
        handleData,
      );
    });

    it("passes segments from payload to renderSegments", async () => {
      const fakeSegments = [{ type: "route", id: "r1", component: null }];

      mockedRenderSegments.mockImplementation(() =>
        Promise.resolve(React.createElement("div", null, "rendered")),
      );

      const deps = createRealDeps({
        createFromReadableStream: vi.fn().mockResolvedValue({
          metadata: {
            pathname: "/",
            params: {},
            matched: ["/"],
            segments: fakeSegments,
          },
        }),
      });

      const renderHTML = createSSRHandler(deps);
      const stream = await renderHTML(createMockRscStream());
      await consumeStream(stream);

      expect(mockedRenderSegments).toHaveBeenCalledWith(fakeSegments, {
        rootLayout: undefined,
      });
      // renderSegments must run exactly once per initial document render.
      // It is async, so React.use() on a fresh promise would suspend and replay
      // SsrRoot, re-running the entire segment-tree build a second time unless
      // the promise is memoized like the sibling payload/handles promises.
      expect(mockedRenderSegments).toHaveBeenCalledTimes(1);
    });

    it("SSR event controller throws on navigation attempt", async () => {
      let captured: NavigationStoreContextValue | null = null;

      function ContextReader() {
        captured = useContext(NavigationStoreContext);
        return React.createElement("div", null, "ok");
      }

      mockedRenderSegments.mockImplementation(() =>
        Promise.resolve(React.createElement(ContextReader)),
      );

      const deps = createRealDeps();
      const renderHTML = createSSRHandler(deps);
      const stream = await renderHTML(createMockRscStream());
      await consumeStream(stream);

      expect(captured).not.toBeNull();
      expect(() => captured!.eventController.startNavigation("/foo")).toThrow(
        "Navigation not supported during SSR",
      );
    });
  });

  describe("streamMode", () => {
    afterEach(() => {
      mockedRenderSegments.mockReset();
      mockedRenderSegments.mockImplementation(() =>
        Promise.resolve(React.createElement("div")),
      );
    });

    async function consumeStream(
      stream: ReadableStream<Uint8Array>,
    ): Promise<string> {
      const reader = stream.getReader();
      const chunks: Uint8Array[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
      return new TextDecoder().decode(
        chunks.reduce((acc, c) => {
          const merged = new Uint8Array(acc.length + c.length);
          merged.set(acc);
          merged.set(c, acc.length);
          return merged;
        }, new Uint8Array(0)),
      );
    }

    function createRealDeps(
      overrides: Partial<SSRDependencies> = {},
    ): SSRDependencies {
      return {
        createFromReadableStream: vi.fn().mockResolvedValue({
          metadata: {
            pathname: "/",
            params: {},
            matched: ["/"],
            segments: [],
          },
        }),
        renderToReadableStream: realRenderToReadableStream as any,
        injectRSCPayload: vi.fn().mockReturnValue(
          new TransformStream({
            transform(chunk, controller) {
              controller.enqueue(chunk);
            },
          }),
        ),
        loadBootstrapScriptContent: vi.fn().mockResolvedValue(""),
        ...overrides,
      };
    }

    it("default (no streamMode) does not await allReady", async () => {
      const deps = createRealDeps();
      const renderHTML = createSSRHandler(deps);
      const stream = await renderHTML(createMockRscStream());
      const html = await consumeStream(stream);
      expect(html).toContain("<div>");
    });

    it('streamMode "stream" does not await allReady', async () => {
      const deps = createRealDeps();
      const renderHTML = createSSRHandler(deps);
      const stream = await renderHTML(createMockRscStream(), {
        streamMode: "stream",
      });
      const html = await consumeStream(stream);
      expect(html).toContain("<div>");
    });

    it('streamMode "allReady" awaits allReady before returning', async () => {
      // Use a Suspense boundary with a delayed promise to verify that
      // renderHTML stays pending until the inner content resolves.
      let resolveInner!: () => void;
      const innerPromise = new Promise<void>((r) => {
        resolveInner = r;
      });

      function Slow() {
        React.use(innerPromise);
        return React.createElement("span", null, "loaded");
      }

      mockedRenderSegments.mockImplementation(() =>
        Promise.resolve(
          React.createElement(
            React.Suspense,
            { fallback: React.createElement("span", null, "loading...") },
            React.createElement(Slow),
          ),
        ),
      );

      const deps = createRealDeps();
      const renderHTML = createSSRHandler(deps);

      // Start renderHTML but do NOT resolve the inner promise yet.
      const renderPromise = renderHTML(createMockRscStream(), {
        streamMode: "allReady",
      });

      // renderHTML should still be pending because allReady hasn't resolved.
      let settled = false;
      renderPromise.then(() => {
        settled = true;
      });
      // Flush microtasks
      await new Promise((r) => setTimeout(r, 50));
      expect(settled).toBe(false);

      // Now resolve the inner promise, which settles allReady.
      resolveInner();

      const stream = await renderPromise;
      const html = await consumeStream(stream);
      expect(html).toContain("loaded");
    });

    it('streamMode "stream" returns stream before Suspense resolves', async () => {
      let resolveInner!: () => void;
      const innerPromise = new Promise<void>((r) => {
        resolveInner = r;
      });

      function Slow() {
        React.use(innerPromise);
        return React.createElement("span", null, "loaded");
      }

      mockedRenderSegments.mockImplementation(() =>
        Promise.resolve(
          React.createElement(
            React.Suspense,
            { fallback: React.createElement("span", null, "loading...") },
            React.createElement(Slow),
          ),
        ),
      );

      const deps = createRealDeps();
      const renderHTML = createSSRHandler(deps);

      // In stream mode, renderHTML should return immediately (shell ready),
      // even though the inner content is still pending.
      const stream = await renderHTML(createMockRscStream(), {
        streamMode: "stream",
      });
      expect(stream).toBeInstanceOf(ReadableStream);

      // Resolve inner so the stream can complete for cleanup.
      resolveInner();
      const html = await consumeStream(stream);
      expect(html).toContain("loaded");
    });
  });

  // Verify that two concurrent renderHTML() calls with different metadata
  // produce isolated contexts — no cross-request bleed of pathname, params,
  // or handle data.
  describe("concurrent SSR isolation", () => {
    afterEach(() => {
      mockedRenderSegments.mockReset();
      mockedRenderSegments.mockImplementation(() =>
        Promise.resolve(React.createElement("div")),
      );
    });

    async function consumeStream(
      stream: ReadableStream<Uint8Array>,
    ): Promise<void> {
      const reader = stream.getReader();
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
    }

    it("concurrent calls do not share pathname, params, or handles", async () => {
      const captured = new Map<string, NavigationStoreContextValue>();

      function ContextReader() {
        const ctx = useContext(NavigationStoreContext);
        if (ctx) {
          const pathname = ctx.eventController.getLocation().pathname;
          captured.set(pathname, ctx);
        }
        return React.createElement("div", null, "ok");
      }

      mockedRenderSegments.mockImplementation(() =>
        Promise.resolve(React.createElement(ContextReader)),
      );

      // Each call gets its own createFromReadableStream mock via separate deps.
      // Both use the same renderToReadableStream (real renderer).
      const makeDeps = (
        pathname: string,
        params: Record<string, string>,
      ): SSRDependencies => ({
        createFromReadableStream: vi.fn().mockResolvedValue({
          metadata: { pathname, params, matched: [pathname], segments: [] },
        }),
        renderToReadableStream: realRenderToReadableStream as any,
        injectRSCPayload: vi.fn().mockReturnValue(
          new TransformStream({
            transform(chunk, controller) {
              controller.enqueue(chunk);
            },
          }),
        ),
        loadBootstrapScriptContent: vi.fn().mockResolvedValue(""),
      });

      const handler1 = createSSRHandler(makeDeps("/users/1", { id: "1" }));
      const handler2 = createSSRHandler(makeDeps("/users/2", { id: "2" }));

      // Run concurrently
      const [stream1, stream2] = await Promise.all([
        handler1(createMockRscStream()),
        handler2(createMockRscStream()),
      ]);

      await Promise.all([consumeStream(stream1), consumeStream(stream2)]);

      expect(captured.size).toBe(2);

      const ctx1 = captured.get("/users/1")!;
      const ctx2 = captured.get("/users/2")!;

      expect(ctx1).toBeDefined();
      expect(ctx2).toBeDefined();

      // Each context holds its own request-scoped values
      expect(ctx1.eventController.getParams()).toEqual({ id: "1" });
      expect(ctx2.eventController.getParams()).toEqual({ id: "2" });

      // Contexts are different objects (not shared)
      expect(ctx1.eventController).not.toBe(ctx2.eventController);
    });
  });
});
