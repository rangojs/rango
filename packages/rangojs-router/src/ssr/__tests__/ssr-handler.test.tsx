import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
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
import { renderToReadableStream as edgeRenderToReadableStream } from "react-dom/server.edge";
import { createServerReference } from "@vitejs/plugin-rsc/react/ssr";

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
    // dc-t93: a failed shell is rethrown to the host in dev only; production
    // answers a document (shell-error-document.test.tsx has the documents).
    it("dev: calls onError once and rethrows the same error instance when rendering fails", async () => {
      const onError = vi.fn();
      const renderError = new Error("Rendering failed");

      const deps = createMockDeps({
        renderToReadableStream: vi.fn().mockRejectedValue(renderError),
        onError,
      });

      const renderHTML = createSSRHandler(deps);

      await expect(renderHTML(createMockRscStream())).rejects.toBe(renderError);

      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError).toHaveBeenCalledWith(renderError, { phase: "rendering" });
    });

    it("production: calls onError once and answers a document when rendering fails", async () => {
      vi.stubEnv("NODE_ENV", "production");
      vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const onError = vi.fn();
        const renderError = new Error("Rendering failed");

        const deps = createMockDeps({
          renderToReadableStream: vi.fn().mockRejectedValue(renderError),
          onError,
        });

        const renderHTML = createSSRHandler(deps);

        const html = await new Response(
          await renderHTML(createMockRscStream()),
        ).text();

        expect(html).toContain("<h1>Internal Server Error</h1>");
        expect(onError).toHaveBeenCalledTimes(1);
        expect(onError).toHaveBeenCalledWith(renderError, {
          phase: "rendering",
        });
      } finally {
        vi.unstubAllEnvs();
        vi.mocked(console.error).mockRestore();
      }
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

  describe("progressiveChunkSize", () => {
    const fizzOptions = (deps: SSRDependencies) =>
      vi.mocked(deps.renderToReadableStream).mock.calls[0]![1]!;

    it("forwards an explicit value to renderToReadableStream", async () => {
      const deps = createMockDeps({ progressiveChunkSize: 4096 });
      const renderHTML = createSSRHandler(deps);

      await renderHTML(createMockRscStream());

      expect(fizzOptions(deps).progressiveChunkSize).toBe(4096);
    });

    it("auto-raises to MAX_SAFE_INTEGER when a payload segment carries awaitBeforeFlush", async () => {
      const deps = createMockDeps({
        createFromReadableStream: vi.fn().mockResolvedValue({
          metadata: {
            pathname: "/",
            matched: ["/"],
            segments: [
              { id: "layout" },
              { id: "loader-products", awaitBeforeFlush: true },
            ],
          },
        }),
      });
      const renderHTML = createSSRHandler(deps);

      await renderHTML(createMockRscStream());

      expect(fizzOptions(deps).progressiveChunkSize).toBe(
        Number.MAX_SAFE_INTEGER,
      );
    });

    it("stays unset when no segment carries the flag", async () => {
      const deps = createMockDeps();
      const renderHTML = createSSRHandler(deps);

      await renderHTML(createMockRscStream());

      expect("progressiveChunkSize" in fizzOptions(deps)).toBe(false);
    });

    it("explicit value disables the auto-raise", async () => {
      const deps = createMockDeps({
        progressiveChunkSize: 4096,
        createFromReadableStream: vi.fn().mockResolvedValue({
          metadata: {
            pathname: "/",
            matched: ["/"],
            segments: [{ id: "loader-products", awaitBeforeFlush: true }],
          },
        }),
      });
      const renderHTML = createSSRHandler(deps);

      await renderHTML(createMockRscStream());

      expect(fizzOptions(deps).progressiveChunkSize).toBe(4096);
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

    // Dev documents settle the client-reference loads their Flight decode
    // requested before the first flush (#1106). plugin-rsc's SSR loader is
    // the global the Flight client calls for an import row.
    describe("dev client-reference loads", () => {
      const g = globalThis as {
        __vite_rsc_client_require__?: (id: string) => unknown;
      };
      let previousLoader: ((id: string) => unknown) | undefined;
      beforeEach(() => {
        previousLoader = g.__vite_rsc_client_require__;
      });
      afterEach(() => {
        g.__vite_rsc_client_require__ = previousLoader;
      });

      it("the first flush waits for a load the decode requested", async () => {
        const order: string[] = [];
        let resolveLoad!: () => void;
        const load = new Promise<void>((r) => {
          resolveLoad = r;
        });
        g.__vite_rsc_client_require__ = () => load;

        function Badge() {
          React.use(load);
          return React.createElement("span", null, "badge-content");
        }
        mockedRenderSegments.mockImplementation(() =>
          Promise.resolve(
            React.createElement(
              React.Suspense,
              { fallback: React.createElement("span", null, "badge-fallback") },
              React.createElement(Badge),
            ),
          ),
        );
        const deps = createRealDeps({
          createFromReadableStream: vi.fn().mockImplementation(async () => {
            void g.__vite_rsc_client_require__!("/src/badge.tsx#Badge");
            return {
              metadata: { pathname: "/", params: {}, matched: ["/"] },
            };
          }),
          // The module settles after the shell is ready, as a module-runner
          // import does in dev.
          renderToReadableStream: (async (
            ...args: Parameters<typeof realRenderToReadableStream>
          ) => {
            const stream = await realRenderToReadableStream(...args);
            setTimeout(() => {
              order.push("load settled");
              resolveLoad();
            }, 20);
            return stream;
          }) as SSRDependencies["renderToReadableStream"],
        });

        const stream = await createSSRHandler(deps)(createMockRscStream());
        order.push("stream returned");
        expect(order).toEqual(["load settled", "stream returned"]);
        const html = await consumeStream(stream);
        expect(html).toContain("badge-content");
        expect(html).not.toContain("badge-fallback");
      });

      it("a load requested outside the document's decode does not hold its flush", async () => {
        g.__vite_rsc_client_require__ = () => new Promise<void>(() => {});
        mockedRenderSegments.mockImplementation(() =>
          Promise.resolve(React.createElement("div", null, "page")),
        );
        const renderHTML = createSSRHandler(createRealDeps());

        const rendering = renderHTML(createMockRscStream());
        // Another render's load, which never settles.
        void g.__vite_rsc_client_require__!("/src/other.tsx#Other");
        const winner = await Promise.race([
          rendering.then(() => "rendered"),
          new Promise((r) => setTimeout(() => r("held"), 1_000)),
        ]);
        expect(winner).toBe("rendered");
        expect(await consumeStream(await rendering)).toContain("page");
      });

      const metadata = { pathname: "/", params: {}, matched: ["/"] };

      it("a load requested after the shell is ready is not waited for", async () => {
        const order: string[] = [];
        let resolveFirst!: () => void;
        const first = new Promise<void>((r) => {
          resolveFirst = r;
        });
        let resolveLate!: () => void;
        const late = new Promise<void>((r) => {
          resolveLate = r;
        });
        const modules: Record<string, Promise<void>> = {
          "/src/a.tsx#A": first,
          "/src/late.tsx#Late": late,
        };
        g.__vite_rsc_client_require__ = (id) => modules[id];
        const deps = createMockDeps({
          createFromReadableStream: vi.fn().mockImplementation(async () => {
            void g.__vite_rsc_client_require__!("/src/a.tsx#A");
            // A row that arrives while the first load is held names another
            // reference: its data was not there when the shell was ready.
            void first.then(() =>
              setTimeout(() => {
                void g.__vite_rsc_client_require__!("/src/late.tsx#Late");
                setTimeout(() => {
                  order.push("late load settled");
                  resolveLate();
                }, 10);
              }, 0),
            );
            return { metadata };
          }),
          renderToReadableStream: vi.fn().mockImplementation(async () => {
            setTimeout(resolveFirst, 10);
            return new ReadableStream({
              start(controller) {
                controller.close();
              },
            });
          }),
        });

        await createSSRHandler(deps)(createMockRscStream());
        order.push("stream returned");
        expect(order).toEqual(["stream returned"]);
      });

      it("with nothing pending when the shell is ready, the first flush is not held", async () => {
        const order: string[] = [];
        g.__vite_rsc_client_require__ = () => Promise.resolve();
        const deps = createMockDeps({
          createFromReadableStream: vi.fn().mockImplementation(async () => {
            void g.__vite_rsc_client_require__!("/src/a.tsx#A");
            return { metadata };
          }),
          renderToReadableStream: vi.fn().mockImplementation(async () => {
            await new Promise((r) => setTimeout(r, 5));
            // The next task, which the router must not wait for.
            setTimeout(() => order.push("next task"), 0);
            return new ReadableStream({
              start(controller) {
                controller.close();
              },
            });
          }),
        });

        await createSSRHandler(deps)(createMockRscStream());
        order.push("stream returned");
        expect(order).toEqual(["stream returned"]);
      });

      it("a load pending when the shell is ready gets the turn Fizz retries in", async () => {
        const order: string[] = [];
        let resolveLoad!: () => void;
        const load = new Promise<void>((r) => {
          resolveLoad = r;
        });
        g.__vite_rsc_client_require__ = () => load;
        // Fizz's ping: a settled load schedules the waiting task's retry on a
        // setTimeout(0) turn.
        void load.then(() => setTimeout(() => order.push("fizz retried"), 0));
        const deps = createMockDeps({
          createFromReadableStream: vi.fn().mockImplementation(async () => {
            void g.__vite_rsc_client_require__!("/src/a.tsx#A");
            return { metadata };
          }),
          renderToReadableStream: vi.fn().mockImplementation(async () => {
            setTimeout(resolveLoad, 10);
            return new ReadableStream({
              start(controller) {
                controller.close();
              },
            });
          }),
        });

        await createSSRHandler(deps)(createMockRscStream());
        order.push("stream returned");
        expect(order).toEqual(["fizz retried", "stream returned"]);
      });

      it("a load that never settles holds the first flush for 5 seconds, then the document flushes as before", async () => {
        vi.useFakeTimers();
        try {
          g.__vite_rsc_client_require__ = () => new Promise<void>(() => {});
          const deps = createMockDeps({
            createFromReadableStream: vi.fn().mockImplementation(async () => {
              void g.__vite_rsc_client_require__!("/src/stuck.tsx#Stuck");
              return { metadata };
            }),
          });
          let returned: ReadableStream<Uint8Array> | undefined;
          void createSSRHandler(deps)(createMockRscStream()).then((stream) => {
            returned = stream;
          });

          await vi.advanceTimersByTimeAsync(4_990);
          expect(returned).toBeUndefined();
          await vi.advanceTimersByTimeAsync(20);
          expect(returned).toBeInstanceOf(ReadableStream);
          expect(await consumeStream(returned!)).toContain("Test");
        } finally {
          vi.useRealTimers();
        }
      });

      it("a production build installs no hold", async () => {
        vi.stubEnv("NODE_ENV", "production");
        vi.resetModules();
        try {
          const production = await import("../index");
          g.__vite_rsc_client_require__ = () => new Promise<void>(() => {});
          const deps = createMockDeps({
            createFromReadableStream: vi.fn().mockImplementation(async () => {
              void g.__vite_rsc_client_require__!("/src/stuck.tsx#Stuck");
              return { metadata };
            }),
          });
          const winner = await Promise.race([
            production
              .createSSRHandler(deps)(createMockRscStream())
              .then(() => "rendered"),
            new Promise((r) => setTimeout(() => r("held"), 1_000)),
          ]);
          expect(winner).toBe("rendered");
        } finally {
          vi.unstubAllEnvs();
          vi.resetModules();
        }
      });
    });

    // A document whose chain has an ssr: false loader settles the Fizz tasks
    // parked on settling thenables before its first flush (#1138). The form
    // action is what useActionState makes of the server reference the SSR
    // environment imports: a bound reference, whose encode suspends once.
    describe("ssr: false first flush", () => {
      const save = createServerReference("test#save") as (
        previous: string | null,
        formData: FormData,
      ) => Promise<string>;
      const rename = createServerReference("test#rename") as typeof save;

      function SaveForm({ children }: { children?: React.ReactNode }) {
        const [, action] = React.useActionState(save, null);
        return (
          <form action={action}>
            <button>Save</button>
            {children}
          </form>
        );
      }

      // Renders on the SaveForm task's retry: a second generation.
      function RenameButton() {
        const [, action] = React.useActionState(rename, null);
        return <button formAction={action}>Rename</button>;
      }

      function Page({ children }: { children: React.ReactNode }) {
        return (
          <main>
            <h1>Frame</h1>
            <React.Suspense fallback={<p>Reading</p>}>
              {children}
            </React.Suspense>
          </main>
        );
      }

      // The tree arrives a turn after Fizz starts, as a Flight row or a
      // client module does: Fizz then retries pinged tasks on setTimeout(0).
      function segmentsAfterATurn(tree: React.ReactNode): void {
        mockedRenderSegments.mockImplementation(
          () => new Promise((resolve) => setTimeout(() => resolve(tree), 0)),
        );
      }

      function ssrFalseDeps(
        overrides: Partial<SSRDependencies> = {},
      ): SSRDependencies {
        return createRealDeps({
          createFromReadableStream: vi.fn().mockResolvedValue({
            metadata: {
              pathname: "/",
              params: {},
              matched: ["/"],
              segments: [{ id: "M0D0.loader", awaitBeforeFlush: true }],
            },
          }),
          renderToReadableStream:
            edgeRenderToReadableStream as SSRDependencies["renderToReadableStream"],
          ...overrides,
        });
      }

      function expectWhole(html: string): void {
        expect(html).not.toContain("<!--$?-->");
        expect(html).not.toContain('<div hidden id="S:');
        expect(html).not.toContain("Reading");
      }

      /**
       * Fizz started through the real renderer, then `onShellReady` runs when
       * the shell is ready: a timer it sets is the turn after shell-ready.
       */
      function renderWithShellReadyHook(
        onShellReady: () => void,
      ): SSRDependencies["renderToReadableStream"] {
        return (async (
          ...args: Parameters<typeof edgeRenderToReadableStream>
        ) => {
          const stream = await edgeRenderToReadableStream(...args);
          onShellReady();
          return stream;
        }) as SSRDependencies["renderToReadableStream"];
      }

      it("a useActionState form under an inline Suspense is whole in the first flush", async () => {
        segmentsAfterATurn(
          <Page>
            <SaveForm />
          </Page>,
        );
        const stream = await createSSRHandler(ssrFalseDeps())(
          createMockRscStream(),
        );
        const html = await consumeStream(stream);
        expect(html).toContain("Save</button>");
        expectWhole(html);
      });

      it("an explicit progressiveChunkSize, which skips the auto-raise, still settles the form", async () => {
        segmentsAfterATurn(
          <Page>
            <SaveForm />
          </Page>,
        );
        const stream = await createSSRHandler(
          ssrFalseDeps({ progressiveChunkSize: 4096 }),
        )(createMockRscStream());
        const html = await consumeStream(stream);
        expect(html).toContain("Save</button>");
        expectWhole(html);
      });

      it("a formAction button inside the form, which renders on its retry, is whole too", async () => {
        segmentsAfterATurn(
          <Page>
            <SaveForm>
              <RenameButton />
            </SaveForm>
          </Page>,
        );
        const stream = await createSSRHandler(ssrFalseDeps())(
          createMockRscStream(),
        );
        const html = await consumeStream(stream);
        expect(html).toContain("Rename</button>");
        expectWhole(html);
      });

      it("a lazy() form with a formAction button inside, three generations, is whole too", async () => {
        const LazyForm = React.lazy(async () => ({
          default: () => (
            <SaveForm>
              <RenameButton />
            </SaveForm>
          ),
        }));
        segmentsAfterATurn(
          <Page>
            <LazyForm />
          </Page>,
        );
        const stream = await createSSRHandler(ssrFalseDeps())(
          createMockRscStream(),
        );
        const html = await consumeStream(stream);
        expect(html).toContain("Rename</button>");
        expectWhole(html);
      });

      it("a document already whole is returned with no turn", async () => {
        const order: string[] = [];
        mockedRenderSegments.mockImplementation(() =>
          Promise.resolve(<Page>page</Page>),
        );
        const deps = ssrFalseDeps({
          renderToReadableStream: renderWithShellReadyHook(() =>
            setTimeout(() => order.push("next turn"), 0),
          ),
        });

        await createSSRHandler(deps)(createMockRscStream());
        order.push("stream returned");
        expect(order).toEqual(["stream returned"]);
      });

      it("a boundary waiting on I/O still streams its fallback, after at most three turns", async () => {
        let turns = 0;
        let counting = true;
        const countTurns = (): void => {
          if (!counting) return;
          turns++;
          setTimeout(countTurns, 0);
        };
        let resolveData!: () => void;
        const data = new Promise<void>((resolve) => {
          resolveData = resolve;
        });
        function Streamed() {
          React.use(data);
          return <p>streamed</p>;
        }
        segmentsAfterATurn(
          <Page>
            <Streamed />
          </Page>,
        );
        const deps = ssrFalseDeps({
          renderToReadableStream: renderWithShellReadyHook(() =>
            setTimeout(countTurns, 0),
          ),
        });

        const stream = await createSSRHandler(deps)(createMockRscStream());
        counting = false;
        expect(turns).toBeGreaterThan(0);
        expect(turns).toBeLessThanOrEqual(3);
        resolveData();
        const html = await consumeStream(stream);
        expect(html).toContain("<!--$?-->");
        expect(html).toContain("streamed");
      });

      // The #1120 scar: a document without an ssr: false loader flushes as
      // before. A skeleton whose content lands one turn after the shell is
      // ready is still the first flush's.
      it("a document without an ssr: false loader is returned with no turn, so its skeleton flushes first", async () => {
        const order: string[] = [];
        let resolveData!: () => void;
        const data = new Promise<void>((resolve) => {
          resolveData = resolve;
        });
        function Content() {
          React.use(data);
          return <p>content</p>;
        }
        mockedRenderSegments.mockImplementation(() =>
          Promise.resolve(
            <main>
              <React.Suspense fallback={<p>skeleton</p>}>
                <Content />
              </React.Suspense>
            </main>,
          ),
        );
        const deps = createRealDeps({
          renderToReadableStream: renderWithShellReadyHook(() =>
            setTimeout(() => {
              order.push("data");
              resolveData();
            }, 0),
          ),
        });

        const stream = await createSSRHandler(deps)(createMockRscStream());
        order.push("stream returned");
        expect(order).toEqual(["stream returned"]);
        const reader = stream.getReader();
        const first = new TextDecoder().decode((await reader.read()).value);
        expect(first).toContain("skeleton");
        reader.releaseLock();
        expect(await consumeStream(stream)).toContain("content");
      });

      it('streamMode "allReady" keeps awaiting allReady alone', async () => {
        segmentsAfterATurn(
          <Page>
            <SaveForm />
          </Page>,
        );
        const stream = await createSSRHandler(ssrFalseDeps())(
          createMockRscStream(),
          { streamMode: "allReady" },
        );
        expectWhole(await consumeStream(stream));
      });
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
