/**
 * onError Integration Tests
 *
 * Exercises the real segment resolution code paths (a FRESH pass of
 * resolveSegmentWithRevalidation and resolveParallelSegmentsWithRevalidation)
 * with deps wired to match router.ts's trackHandler
 * implementation. Verifies that streaming handler and parallel-slot errors
 * are reported to callOnError through the production code path.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  resolveParallelSegmentsWithRevalidation,
  resolveSegmentWithRevalidation,
} from "../segment-resolution/revalidation.js";
import { makeFreshPass } from "../../__tests__/kit/resolution-pass.js";
import type { SegmentResolutionDeps } from "../types.js";
import type { EntryData } from "../../server/context.js";
import type { ResolvedSegment } from "../../types.js";

// Mock leaf dependencies used by the segment walker
vi.mock("../segment-resolution/loader-cache.js", () => ({
  resolveLoaderData: vi.fn(() => Promise.resolve({ data: "test" })),
}));

vi.mock("../segment-resolution/helpers.js", () => ({
  handleHandlerResult: vi.fn((x: any) => x),
  tryStaticHandler: vi.fn(() => undefined),
  tryStaticSlot: vi.fn(() => undefined),
  resolveLayoutComponent: vi.fn(async (entry: any, _ctx: any) => {
    return typeof entry.handler === "function"
      ? entry.handler(_ctx)
      : entry.handler;
  }),
  resolveWithErrorBoundary: vi.fn(
    async (
      _entry: any,
      _params: any,
      resolveFn: () => Promise<any>,
      wrapError: (seg: ResolvedSegment) => any,
      _deps: any,
    ) => {
      try {
        return await resolveFn();
      } catch (error) {
        if (error instanceof Response) throw error;
        return wrapError({
          id: "error",
          namespace: "error",
          type: "error",
          index: 0,
          component: null,
          params: {},
        });
      }
    },
  ),
  warnOnStreamedResponse: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeContext(): any {
  return {
    request: new Request("http://localhost/test"),
    env: { DB: "test-db" },
    params: { slug: "item-1" },
    pathname: "/test",
    var: {},
    use: vi.fn(() => Promise.resolve({ data: "loader-result" })),
    _currentSegmentId: undefined,
  };
}

function makeRouteEntry(
  handler: any,
  opts?: { loading?: any; shortCode?: string; parallel?: object },
): Exclude<EntryData, { type: "parallel" }> {
  return {
    type: "route",
    shortCode: opts?.shortCode ?? "M1R0",
    id: "test-route",
    handler,
    loading: opts?.loading,
    loader: [],
    layout: [],
    parallel: opts?.parallel ?? {},
    intercept: [],
    revalidate: [],
    errorBoundary: [],
    notFoundBoundary: [],
    middleware: [],
    parent: null,
  } as any;
}

function makeParallelEntry(
  slots: Record<string, any>,
  opts?: { loading?: any },
): EntryData {
  return {
    type: "parallel",
    shortCode: "M1P0",
    id: "test-parallel",
    handler: slots,
    loading: opts?.loading,
    loader: [],
    layout: [],
    parallel: {},
    intercept: [],
    revalidate: [],
    errorBoundary: [],
    notFoundBoundary: [],
    middleware: [],
    parent: null,
  } as any;
}

/** A route entry `shortCode` whose slots are the parallel entry's. */
function makeSlotOwner(parallelEntry: EntryData, shortCode: string): EntryData {
  return makeRouteEntry(() => null, {
    shortCode,
    parallel: Object.fromEntries(
      Object.keys(parallelEntry.handler as object).map((slot) => [
        slot,
        parallelEntry,
      ]),
    ),
  });
}

// ---------------------------------------------------------------------------
// Tests: Streaming route handler via a FRESH segment pass
// ---------------------------------------------------------------------------
describe("Streaming route handler onError (production path)", () => {
  let callOnError: ReturnType<typeof vi.fn>;
  let deps: SegmentResolutionDeps<any>;

  beforeEach(() => {
    callOnError = vi.fn() as any;

    // Wire trackHandler to mirror the real router.ts implementation:
    // attach a side-effect .catch() that calls callOnError
    const trackHandlerFn = vi.fn(
      (promise: Promise<any>, errorContext?: any) => {
        promise.catch((error: any) => {
          (callOnError as any)(error, "handler", {
            request: new Request("http://localhost/test"),
            url: new URL("http://localhost/test"),
            segmentId: errorContext?.segmentId,
            segmentType: errorContext?.segmentType,
            handledByBoundary: true,
          });
        });
        return promise;
      },
    );

    deps = {
      wrapLoaderPromise: vi.fn(async (promise: any) => ({
        __loaderResult: true,
        ok: true,
        data: await promise,
      })) as any,
      trackHandler: trackHandlerFn as any,
      findNearestErrorBoundary: vi.fn(() => null),
      findNearestNotFoundBoundary: vi.fn(() => null),
      callOnError: callOnError as any,
    };
  });

  it("should call trackHandler with segmentId for loading:true route", async () => {
    const handlerPromise = Promise.resolve("streaming content");
    const entry = makeRouteEntry(() => handlerPromise, {
      loading: () => "Loading...",
    });
    const context = makeContext();

    await resolveSegmentWithRevalidation(
      makeFreshPass(context, deps, { routeKey: "test-route" }),
      entry,
    );

    expect(deps.trackHandler).toHaveBeenCalledWith(handlerPromise, {
      segmentId: "M1R0",
      segmentType: "route",
    });
  });

  it("should NOT call trackHandler for non-streaming route (no loading)", async () => {
    const entry = makeRouteEntry(async () => "sync content");
    const context = makeContext();

    await resolveSegmentWithRevalidation(
      makeFreshPass(context, deps, { routeKey: "test-route" }),
      entry,
    );

    expect(deps.trackHandler).not.toHaveBeenCalled();
  });

  it("should report streaming handler rejection to callOnError", async () => {
    const error = new Error("Streaming handler failed");
    const handlerPromise = Promise.reject(error);
    const entry = makeRouteEntry(() => handlerPromise, {
      loading: () => "Loading...",
    });
    const context = makeContext();

    await resolveSegmentWithRevalidation(
      makeFreshPass(context, deps, { routeKey: "test-route" }),
      entry,
    );

    // Wait for the side-effect .catch() to fire
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(callOnError).toHaveBeenCalledWith(
      error,
      "handler",
      expect.objectContaining({
        segmentId: "M1R0",
        segmentType: "route",
        handledByBoundary: true,
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Tests: Streaming parallel-slot handler via a FRESH slot pass
// ---------------------------------------------------------------------------
describe("Streaming parallel-slot handler onError (production path)", () => {
  let callOnError: ReturnType<typeof vi.fn>;
  let deps: SegmentResolutionDeps<any>;

  beforeEach(() => {
    callOnError = vi.fn() as any;

    const trackHandlerFn = vi.fn(
      (promise: Promise<any>, errorContext?: any) => {
        promise.catch((error: any) => {
          (callOnError as any)(error, "handler", {
            request: new Request("http://localhost/test"),
            url: new URL("http://localhost/test"),
            segmentId: errorContext?.segmentId,
            segmentType: errorContext?.segmentType,
            handledByBoundary: true,
          });
        });
        return promise;
      },
    );

    deps = {
      wrapLoaderPromise: vi.fn(async (promise: any) => ({
        __loaderResult: true,
        ok: true,
        data: await promise,
      })) as any,
      trackHandler: trackHandlerFn as any,
      findNearestErrorBoundary: vi.fn(() => null),
      findNearestNotFoundBoundary: vi.fn(() => null),
      callOnError: callOnError as any,
    };
  });

  it("should call trackHandler with segmentId for loading:true parallel slot", async () => {
    const slotPromise = Promise.resolve("slot content");
    const entry = makeParallelEntry(
      { "@sidebar": () => slotPromise },
      { loading: () => "Loading..." },
    );
    const context = makeContext();

    await resolveParallelSegmentsWithRevalidation(
      makeFreshPass(context, deps, { routeKey: "test-route" }),
      makeSlotOwner(entry, "M1R0"),
      true,
    );

    expect(deps.trackHandler).toHaveBeenCalledWith(slotPromise, {
      segmentId: "M1R0.@sidebar",
      segmentType: "parallel",
    });
  });

  it("should NOT call trackHandler for non-streaming parallel slot", async () => {
    const entry = makeParallelEntry(
      { "@sidebar": async () => "sync content" },
      // No loading fallback
    );
    const context = makeContext();

    await resolveParallelSegmentsWithRevalidation(
      makeFreshPass(context, deps, { routeKey: "test-route" }),
      makeSlotOwner(entry, "M1R0"),
      true,
    );

    expect(deps.trackHandler).not.toHaveBeenCalled();
  });

  it("should report streaming parallel-slot rejection to callOnError", async () => {
    const error = new Error("Parallel slot failed");
    const slotPromise = Promise.reject(error);
    const entry = makeParallelEntry(
      { "@sidebar": () => slotPromise },
      { loading: () => "Loading..." },
    );
    const context = makeContext();

    await resolveParallelSegmentsWithRevalidation(
      makeFreshPass(context, deps, { routeKey: "test-route" }),
      makeSlotOwner(entry, "M1R0"),
      true,
    );

    // Wait for the side-effect .catch() to fire
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(callOnError).toHaveBeenCalledWith(
      error,
      "handler",
      expect.objectContaining({
        segmentId: "M1R0.@sidebar",
        segmentType: "parallel",
        handledByBoundary: true,
      }),
    );
  });

  it("should handle multiple parallel slots with mixed sync/async", async () => {
    const asyncError = new Error("Async slot failed");
    const entry = makeParallelEntry(
      {
        "@sidebar": () => Promise.reject(asyncError),
        "@header": () => "sync header",
      },
      { loading: () => "Loading..." },
    );
    const context = makeContext();

    await resolveParallelSegmentsWithRevalidation(
      makeFreshPass(context, deps, { routeKey: "test-route" }),
      makeSlotOwner(entry, "M1R0"),
      true,
    );

    await new Promise((resolve) => setTimeout(resolve, 0));

    // trackHandler called for async slot, not for sync
    expect(deps.trackHandler).toHaveBeenCalledTimes(1);
    expect(deps.trackHandler).toHaveBeenCalledWith(expect.any(Promise), {
      segmentId: "M1R0.@sidebar",
      segmentType: "parallel",
    });

    // Error reported for the failing slot
    expect(callOnError).toHaveBeenCalledWith(
      asyncError,
      "handler",
      expect.objectContaining({
        segmentId: "M1R0.@sidebar",
        segmentType: "parallel",
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Tests: Router-layer dedup through real callOnError wiring
// ---------------------------------------------------------------------------
describe("Router-layer WeakSet dedup (production-path pattern)", () => {
  it("should deduplicate when same error reaches multiple callOnError sites", () => {
    // Simulates the Router-layer callOnError with WeakSet, exercising the
    // exact same pattern used in router.ts (lines 203-218)
    const onErrorCallback = vi.fn();
    const reportedErrors = new WeakSet<object>();

    function callOnError(error: unknown, phase: string, _ctx: any) {
      if (error != null && typeof error === "object") {
        if (reportedErrors.has(error)) return;
        reportedErrors.add(error);
      }
      onErrorCallback({ error, phase });
    }

    const error = new Error("Handler failed");

    // First site: segment resolution reports as "handler"
    callOnError(error, "handler", { segmentId: "M1R0" });
    // Second site: match-handlers.ts catch reports as "routing"
    callOnError(error, "routing", { isPartial: false });

    // Only the first report should fire
    expect(onErrorCallback).toHaveBeenCalledTimes(1);
    expect(onErrorCallback).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "handler" }),
    );
  });

  it("should report separately for different error objects", () => {
    const onErrorCallback = vi.fn();
    const reportedErrors = new WeakSet<object>();

    function callOnError(error: unknown, phase: string, _ctx: any) {
      if (error != null && typeof error === "object") {
        if (reportedErrors.has(error)) return;
        reportedErrors.add(error);
      }
      onErrorCallback({ error, phase });
    }

    callOnError(new Error("Error A"), "handler", {});
    callOnError(new Error("Error B"), "loader", {});

    expect(onErrorCallback).toHaveBeenCalledTimes(2);
  });
});
