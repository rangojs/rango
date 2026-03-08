/**
 * Regression test for "use cache" stale revalidation handle preservation.
 *
 * Verifies that when a stale cache entry triggers background revalidation,
 * the revalidation path captures handle data (breadcrumbs, metadata) and
 * persists it in setItem, so future cache hits replay handles correctly.
 *
 * This exercises the production registerCachedFunction through heavy mocking
 * because cache-runtime.ts imports @vitejs/plugin-rsc/rsc (virtual module).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NOCACHE_SYMBOL } from "../taint.js";

// Mock @vitejs/plugin-rsc/rsc (virtual module, not resolvable in vitest)
vi.mock("@vitejs/plugin-rsc/rsc", () => ({
  encodeReply: vi.fn().mockResolvedValue("encoded-args"),
  createClientTemporaryReferenceSet: vi.fn().mockReturnValue(new Set()),
}));

// Mock request context
const mockGetRequestContext = vi.fn<() => any>(() => null);
vi.mock("../../server/request-context.js", () => ({
  getRequestContext: () => mockGetRequestContext(),
}));

// Mock segment codec — identity transforms for testing
vi.mock("../segment-codec.js", () => ({
  serializeResult: vi.fn((v: any) => JSON.stringify(v)),
  deserializeResult: vi.fn((v: string) => JSON.parse(v)),
}));

// Mock handle snapshot
const mockRestoreHandles = vi.fn();
vi.mock("../handle-snapshot.js", () => ({
  restoreHandles: (...args: any[]) => mockRestoreHandles(...args),
}));

// Mock internal debug
vi.mock("../../internal-debug.js", () => ({
  INTERNAL_RANGO_DEBUG: false,
}));

describe("use cache stale revalidation handle preservation", () => {
  let registerCachedFunction: typeof import("../cache-runtime.js").registerCachedFunction;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockGetRequestContext.mockReturnValue(null);
    // Dynamic import after mocks are installed
    const mod = await import("../cache-runtime.js");
    registerCachedFunction = mod.registerCachedFunction;
  });

  function makeTaintedCtx() {
    return {
      [NOCACHE_SYMBOL]: true,
      params: { id: "1" },
      pathname: "/test",
      searchParams: new URLSearchParams(),
    };
  }

  it("captures and persists handles during stale background revalidation", async () => {
    // Track waitUntil callbacks so we can run them synchronously
    const waitUntilFns: Array<() => Promise<void>> = [];

    const mockStore = {
      getItem: vi.fn(),
      setItem: vi.fn().mockResolvedValue(undefined),
    };

    const mockHandleStore = {
      push: vi.fn(),
      settled: Promise.resolve(),
      getDataForSegment: vi.fn().mockReturnValue({}),
    };

    const taintedCtx = makeTaintedCtx();

    // Set up request context
    mockGetRequestContext.mockReturnValue({
      _cacheStore: mockStore,
      _cacheProfiles: { default: { ttl: 60, swr: 120 } },
      _handleStore: mockHandleStore,
      waitUntil: (fn: () => Promise<void>) => {
        waitUntilFns.push(fn);
      },
    });

    // Return stale cache entry with handles on first getItem
    const staleHandles = { seg1: { breadcrumbs: ["Home", "Products"] } };
    mockStore.getItem.mockResolvedValueOnce({
      value: JSON.stringify("stale-result"),
      handles: staleHandles,
      shouldRevalidate: true,
    });

    // The underlying function pushes handle data when re-executed
    let callCount = 0;
    const fn = async (ctx: any) => {
      callCount++;
      // Simulate handle push during execution
      if (mockHandleStore.push.mock) {
        mockHandleStore.push("breadcrumbs", "seg1", "Fresh Breadcrumb");
      }
      return `fresh-result-${callCount}`;
    };

    const cached = registerCachedFunction(fn, "test-fn", "default");

    // Call the cached function — should get stale result back
    const result = await cached(taintedCtx);
    expect(result).toBe("stale-result");

    // Verify stale handles were restored
    expect(mockRestoreHandles).toHaveBeenCalledWith(
      staleHandles,
      mockHandleStore,
    );

    // Now run the background revalidation callback
    expect(waitUntilFns).toHaveLength(1);
    await waitUntilFns[0]();

    // Verify setItem was called with handles data
    expect(mockStore.setItem).toHaveBeenCalledTimes(1);
    const setItemCall = mockStore.setItem.mock.calls[0];
    const setItemOptions = setItemCall[2];

    // The handles option must be present (not undefined)
    expect(setItemOptions).toBeDefined();
    expect(setItemOptions.handles).toBeDefined();
    expect(setItemOptions.ttl).toBe(60);
    expect(setItemOptions.swr).toBe(120);
  });

  it("stamps INSIDE_CACHE_EXEC on tainted args during stale background revalidation", async () => {
    const waitUntilFns: Array<() => Promise<void>> = [];

    const mockStore = {
      getItem: vi.fn(),
      setItem: vi.fn().mockResolvedValue(undefined),
    };

    const mockHandleStore = {
      push: vi.fn(),
      settled: Promise.resolve(),
      getDataForSegment: vi.fn().mockReturnValue({}),
    };

    const taintedCtx = makeTaintedCtx();

    const requestCtxObj = {
      _cacheStore: mockStore,
      _cacheProfiles: { default: { ttl: 60, swr: 120 } },
      _handleStore: mockHandleStore,
      waitUntil: (fn: () => Promise<void>) => {
        waitUntilFns.push(fn);
      },
    };
    mockGetRequestContext.mockReturnValue(requestCtxObj);

    // Return stale cache entry
    mockStore.getItem.mockResolvedValueOnce({
      value: JSON.stringify("stale-result"),
      handles: {},
      shouldRevalidate: true,
    });

    // The function reads the taint flag during background execution
    const INSIDE_CACHE_EXEC = Symbol.for("rango:inside-cache-exec");
    let taintedDuringBgExec = false;
    let requestCtxTaintedDuringBgExec = false;
    const fn = async (ctx: any) => {
      taintedDuringBgExec = !!(ctx as any)[INSIDE_CACHE_EXEC];
      const bgReqCtx = mockGetRequestContext();
      requestCtxTaintedDuringBgExec = !!(bgReqCtx as any)[INSIDE_CACHE_EXEC];
      return "fresh-result";
    };

    const cached = registerCachedFunction(fn, "test-taint-bg", "default");
    await cached(taintedCtx);

    // Run background revalidation
    expect(waitUntilFns).toHaveLength(1);
    await waitUntilFns[0]();

    // Both the tainted arg and the ALS RequestContext should have been stamped
    expect(taintedDuringBgExec).toBe(true);
    expect(requestCtxTaintedDuringBgExec).toBe(true);

    // After background execution, the stamps should be cleaned up
    expect((taintedCtx as any)[INSIDE_CACHE_EXEC]).toBeUndefined();
    expect((requestCtxObj as any)[INSIDE_CACHE_EXEC]).toBeUndefined();
  });

  it("fresh hit path does not trigger background revalidation", async () => {
    const waitUntilFns: Array<() => Promise<void>> = [];

    const mockStore = {
      getItem: vi.fn(),
      setItem: vi.fn(),
    };

    const mockHandleStore = {
      push: vi.fn(),
      settled: Promise.resolve(),
      getDataForSegment: vi.fn().mockReturnValue({}),
    };

    const taintedCtx = makeTaintedCtx();

    mockGetRequestContext.mockReturnValue({
      _cacheStore: mockStore,
      _cacheProfiles: { default: { ttl: 60 } },
      _handleStore: mockHandleStore,
      waitUntil: (fn: () => Promise<void>) => {
        waitUntilFns.push(fn);
      },
    });

    // Fresh hit (shouldRevalidate: false)
    const freshHandles = { seg1: { breadcrumbs: ["Cached"] } };
    mockStore.getItem.mockResolvedValueOnce({
      value: JSON.stringify("cached-result"),
      handles: freshHandles,
      shouldRevalidate: false,
    });

    const fn = async (_ctx: any) => "should-not-run";
    const cached = registerCachedFunction(fn, "test-fn-fresh", "default");

    const result = await cached(taintedCtx);
    expect(result).toBe("cached-result");

    // Fresh hit restores handles
    expect(mockRestoreHandles).toHaveBeenCalledWith(
      freshHandles,
      mockHandleStore,
    );

    // No background revalidation should be queued
    expect(waitUntilFns).toHaveLength(0);
    expect(mockStore.setItem).not.toHaveBeenCalled();
  });

  it("miss path captures and stores handles", async () => {
    const mockStore = {
      getItem: vi.fn().mockResolvedValue(null), // Cache miss
      setItem: vi.fn().mockResolvedValue(undefined),
    };

    const mockHandleStore = {
      push: vi.fn(),
      settled: Promise.resolve(),
      getDataForSegment: vi.fn().mockReturnValue({}),
    };

    const taintedCtx = makeTaintedCtx();

    mockGetRequestContext.mockReturnValue({
      _cacheStore: mockStore,
      _cacheProfiles: { default: { ttl: 60 } },
      _handleStore: mockHandleStore,
      waitUntil: undefined, // No waitUntil — runs inline
    });

    const fn = async (_ctx: any) => "fresh-result";
    const cached = registerCachedFunction(fn, "test-fn-miss", "default");

    const result = await cached(taintedCtx);
    expect(result).toBe("fresh-result");

    // setItem should have been called with handles
    expect(mockStore.setItem).toHaveBeenCalledTimes(1);
    const setItemOptions = mockStore.setItem.mock.calls[0][2];
    expect(setItemOptions).toBeDefined();
    // handles should be an object (possibly empty if nothing was pushed)
    expect(setItemOptions.handles).toBeDefined();
  });
});
