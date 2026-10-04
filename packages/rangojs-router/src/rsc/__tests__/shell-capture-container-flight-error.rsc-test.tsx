/**
 * A PPR shell capture whose bake-lane loader container fails to encode is not
 * stored (issue #927).
 *
 * The capture pins each settled bake-lane container into the shell snapshot
 * with serializeResult. Flight never rejects for a value it cannot encode (an
 * async server component that throws, a rejected promise, a function, a class
 * instance): it calls onError and completes with an error row (`N:E{...}`),
 * which every shell HIT would then seed. Runs the capture core with real
 * Flight (the vendored react-server-dom) for that encode; the capture render
 * and the SSR prerender are stubbed, so only the encode can report. That is
 * the build-time producer's shape (its Flight render errors do not refuse)
 * and a server component that throws only when the encode runs it again.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ReactNode } from "react";

vi.mock("@vitejs/plugin-rsc/rsc/server", async () => {
  const RSD =
    await import("@vitejs/plugin-rsc/vendor/react-server-dom/server.edge");
  return {
    // The vendored implementation (not in its ambient declaration).
    createTemporaryReferenceSet: () => new WeakMap(),
    renderToReadableStream: (value: unknown, options?: object) =>
      RSD.renderToReadableStream(value, {}, options),
  };
});
vi.mock("@vitejs/plugin-rsc/rsc/client", async () => {
  await import("../../testing/internal/flight-client-globals.js");
  const { createFromReadableStream } =
    await import("@vitejs/plugin-rsc/react/browser");
  return {
    createFromReadableStream: (stream: ReadableStream<Uint8Array>) =>
      createFromReadableStream(stream),
    createClientTemporaryReferenceSet: () => new Set(),
    encodeReply: async () => {
      throw new Error("encodeReply is not expected in this test");
    },
  };
});

import {
  scheduleShellCapture,
  isCaptureBackedOff,
  clearCaptureBackoff,
} from "../shell-capture.js";
import { RecordingShellStore } from "../../cache/shell-snapshot.js";
import { MemorySegmentCacheStore } from "../../cache/memory-segment-store.js";
import type { ShellSnapshotLoaderValue } from "../../cache/types.js";
import {
  createRequestContext,
  getRequestContext,
  type RequestContext,
} from "../../server/request-context.js";
import type { HandlerContext } from "../handler-context.js";
import type { SSRModule } from "../types.js";

async function Reviews(): Promise<ReactNode> {
  await Promise.resolve();
  throw new Error("reviews upstream down");
}

class Price {
  constructor(readonly amount: number) {}
}

/** A settled rejection with a handler attached, so only Flight observes it. */
function rejected(message: string): Promise<never> {
  const promise = Promise.reject(new Error(message));
  promise.catch(() => {});
  return promise;
}

function emptyStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(c) {
      c.close();
    },
  });
}

function errorRows(encoded: string): string[] {
  return encoded.match(/^\d+:E.*$/gm) ?? [];
}

const SEGMENT_KEY = "M0D0.app/product#ProductLoader";

let store: MemorySegmentCacheStore;
let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  store = new MemorySegmentCacheStore();
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  errSpy.mockRestore();
});

/**
 * Run one scheduled capture of `key` whose bake-lane loader settles with
 * `container`. The capture's match registers the record the way
 * resolveLoaderData does for an `ssr: false` loader.
 */
async function capture(
  key: string,
  container: unknown,
): Promise<{ reqCtx: RequestContext }> {
  const ctx = {
    version: "v-test",
    router: {
      id: "test-router",
      basename: undefined,
      rootLayout: undefined,
      resolvedStateCookieName: "rango-state",
      themeConfig: undefined,
      prefetchCacheTTL: 0,
      prefetchCacheSize: 0,
      prefetchConcurrency: 0,
      warmupEnabled: true,
      strictMode: false,
      onError: undefined,
      match: vi.fn(async () => {
        const captureCtx = getRequestContext();
        captureCtx._shellCaptureLoaderRecords?.set(
          SEGMENT_KEY,
          Promise.resolve(container),
        );
        // The doc record a real match's doc scope writes (a capture without
        // one is refused before its loaders are drained).
        captureCtx._shellImplicitCache!.docKey = "doc:localhost/p";
        (captureCtx._cacheStore as RecordingShellStore).recordSegmentWrite(
          "doc:localhost/p",
          {
            segments: [{ encoded: "0:null", metadata: { id: "R0" } } as any],
            handles: "",
            expiresAt: Date.now() + 300_000,
          },
        );
        return {
          redirect: undefined,
          segments: [],
          matched: [],
          diff: [],
          resolvedIds: [],
          params: {},
          routeName: "product",
        };
      }),
    },
    callOnError: vi.fn(),
    renderToReadableStream: vi.fn(() => emptyStream()),
  } as unknown as HandlerContext<any>;
  const ssrModule = {
    renderHTML: vi.fn(),
    resumeShellHTML: vi.fn(),
    captureShellHTML: vi.fn(async () => ({
      prelude: new TextEncoder().encode("<html><body>shell</body></html>"),
      postponed: null,
    })),
  } as unknown as SSRModule;

  const url = new URL(`http://localhost${key}`);
  const request = new Request(url);
  const reqCtx = createRequestContext({
    env: {},
    request,
    url,
    variables: {},
    cacheStore: store,
  }) as RequestContext;
  (reqCtx as any)._reportBackgroundError = vi.fn();
  const tasks: Array<() => Promise<void>> = [];
  (reqCtx as any).waitUntil = (task: () => Promise<void>) => {
    tasks.push(task);
  };

  scheduleShellCapture(ctx, request, {}, url, reqCtx, ssrModule, {
    key,
    buildVersion: "test-build",
    ttl: 300,
    store,
  });
  expect(tasks).toHaveLength(1);
  await tasks[0]!();
  return { reqCtx };
}

/** The stored loader record's encoded container, or null when nothing stored. */
async function storedContainer(key: string): Promise<string | null> {
  const hit = await store.getShell(key);
  if (!hit) return null;
  const record = hit.entry.snapshot?.find(
    (r) => r.family === "loader" && r.key === SEGMENT_KEY,
  );
  return (record?.value as ShellSnapshotLoaderValue | undefined)?.value ?? "";
}

describe("PPR shell capture: a bake-lane container whose encode reports an error", () => {
  it.each([
    [
      "an async component that throws",
      () => ({ product: "p1", reviews: <Reviews /> }),
      "reviews upstream down",
    ],
    [
      "a function",
      () => ({ product: "p1", format: (n: number) => `$${n}` }),
      "Functions cannot be passed directly",
    ],
    [
      "a class instance",
      () => ({ product: "p1", price: new Price(42) }),
      "Only plain objects",
    ],
    [
      // The elide walk probes only plain objects and arrays, so this one is
      // not caught by the rejected-container refusal.
      "a rejected promise inside a Map",
      () => ({
        product: "p1",
        stock: new Map([["p1", rejected("stock upstream down")]]),
      }),
      "stock upstream down",
    ],
  ])(
    "%s: nothing is stored, the error is reported and the key backs off",
    async (label, container, message) => {
      const key = `/product-${label.replace(/\W+/g, "-")}:shell`;
      const { reqCtx } = await capture(key, container());

      expect(await storedContainer(key)).toBeNull();
      const report = vi.mocked((reqCtx as any)._reportBackgroundError);
      expect(report).toHaveBeenCalledTimes(1);
      expect(report.mock.calls[0]![1]).toBe("cache-write");
      expect((report.mock.calls[0]![0] as Error).message).toContain(message);
      expect(isCaptureBackedOff(key)).toBe(true);
      clearCaptureBackoff(key);
    },
  );

  it("a container that encodes cleanly is pinned without error rows", async () => {
    const key = "/product-clean:shell";
    const { reqCtx } = await capture(key, {
      product: "p1",
      reviews: <p>great</p>,
      price: 42,
    });

    const encoded = await storedContainer(key);
    expect(encoded).toContain("great");
    expect(errorRows(encoded!)).toEqual([]);
    expect((reqCtx as any)._reportBackgroundError).not.toHaveBeenCalled();
  });
});
