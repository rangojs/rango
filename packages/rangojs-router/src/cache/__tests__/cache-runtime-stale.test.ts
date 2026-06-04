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
// encodeReply serializes args so different inputs produce different cache keys.
vi.mock("@vitejs/plugin-rsc/rsc", () => ({
  encodeReply: vi.fn((args: unknown[]) =>
    Promise.resolve(JSON.stringify(args)),
  ),
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

    // Tainted args should be stamped during background execution
    expect(taintedDuringBgExec).toBe(true);
    // RequestContext is intentionally NOT stamped in background to avoid
    // polluting the shared foreground context (see cache-runtime.ts comment)
    expect(requestCtxTaintedDuringBgExec).toBe(false);

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

  it("concurrent cache misses sharing the same ctx keep the guard until all finish", async () => {
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

    const requestCtxObj = {
      _cacheStore: mockStore,
      _cacheProfiles: { default: { ttl: 60 } },
      _handleStore: mockHandleStore,
      waitUntil: undefined,
    };
    mockGetRequestContext.mockReturnValue(requestCtxObj);

    const INSIDE = Symbol.for("rango:inside-cache-exec");

    // cachedA resolves fast, cachedB resolves slow.
    // If stamp is boolean, cachedA's cleanup clears the guard for cachedB.
    let resolveB: (v: string) => void;
    const bPromise = new Promise<string>((r) => {
      resolveB = r;
    });

    let guardActiveInB = false;

    const cachedA = registerCachedFunction(
      async (_ctx: any) => "resultA",
      "fn-a",
      "default",
    );
    const cachedB = registerCachedFunction(
      async (ctx: any) => {
        // Wait until cachedA has completed
        await bPromise;
        // At this point, with boolean stamp, the guard would be cleared.
        // With ref counting, it should still be active.
        guardActiveInB = !!(ctx as any)[INSIDE];
        return "resultB";
      },
      "fn-b",
      "default",
    );

    // Start both concurrently
    const aPromise = cachedA(taintedCtx);
    const bCallPromise = cachedB(taintedCtx);

    // cachedA finishes first
    await aPromise;

    // Let cachedB continue
    resolveB!("go");
    await bCallPromise;

    // The guard must still have been active inside cachedB even though
    // cachedA finished first
    expect(guardActiveInB).toBe(true);

    // After both are done, the symbol should be fully cleaned up
    expect((taintedCtx as any)[INSIDE]).toBeUndefined();
    expect((requestCtxObj as any)[INSIDE]).toBeUndefined();
  });

  it("stale background revalidation uses isolated handle store, not the live request store", async () => {
    const waitUntilFns: Array<() => Promise<void>> = [];

    const mockStore = {
      getItem: vi.fn(),
      setItem: vi.fn().mockResolvedValue(undefined),
    };

    const liveHandleStore = {
      push: vi.fn(),
      settled: Promise.resolve(),
      getDataForSegment: vi.fn().mockReturnValue({}),
    };

    const taintedCtx = makeTaintedCtx();

    const requestCtxObj = {
      _cacheStore: mockStore,
      _cacheProfiles: { default: { ttl: 60, swr: 120 } },
      _handleStore: liveHandleStore,
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

    // Track whether the handle store was swapped during background execution
    let bgHandleStoreIsLive: boolean | undefined;
    const fn = async (_ctx: any) => {
      // Check if the request context's handle store is the live one
      const bgReqCtx = mockGetRequestContext();
      bgHandleStoreIsLive = bgReqCtx._handleStore === liveHandleStore;
      return "fresh-result";
    };

    const cached = registerCachedFunction(fn, "test-fn-iso", "default");
    await cached(taintedCtx);

    // Run the background revalidation
    expect(waitUntilFns).toHaveLength(1);
    await waitUntilFns[0]();

    // During background execution, the handle store must have been replaced
    // with an isolated one (not the live request's store)
    expect(bgHandleStoreIsLive).toBe(false);

    // After background execution, the original store must be restored
    expect(requestCtxObj._handleStore).toBe(liveHandleStore);
  });

  it("reports stale background revalidation errors via _reportBackgroundError", async () => {
    const waitUntilFns: Array<() => Promise<void>> = [];
    const reportedErrors: Array<{ error: unknown; category: string }> = [];

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

    mockGetRequestContext.mockReturnValue({
      _cacheStore: mockStore,
      _cacheProfiles: { default: { ttl: 60, swr: 120 } },
      _handleStore: mockHandleStore,
      waitUntil: (fn: () => Promise<void>) => {
        waitUntilFns.push(fn);
      },
      _reportBackgroundError: (error: unknown, category: string) => {
        reportedErrors.push({ error, category });
      },
    });

    // Return stale cache entry
    mockStore.getItem.mockResolvedValueOnce({
      value: JSON.stringify("stale-result"),
      handles: {},
      shouldRevalidate: true,
    });

    const bgError = new Error("revalidation boom");
    const fn = async (_ctx: any) => {
      throw bgError;
    };

    const cached = registerCachedFunction(fn, "test-fn-err", "default");
    const result = await cached(taintedCtx);
    expect(result).toBe("stale-result");

    // Run background revalidation (which will throw)
    await waitUntilFns[0]();

    // Error should have been reported, not swallowed
    expect(reportedErrors).toHaveLength(1);
    expect(reportedErrors[0].error).toBe(bgError);
    expect(reportedErrors[0].category).toBe("stale-revalidation");
  });

  it("reports miss-path cache write errors via _reportBackgroundError", async () => {
    const reportedErrors: Array<{ error: unknown; category: string }> = [];

    const writeError = new Error("setItem failed");
    const mockStore = {
      getItem: vi.fn().mockResolvedValue(null),
      setItem: vi.fn().mockRejectedValue(writeError),
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
      waitUntil: undefined,
      _reportBackgroundError: (error: unknown, category: string) => {
        reportedErrors.push({ error, category });
      },
    });

    const fn = async (_ctx: any) => "result";
    const cached = registerCachedFunction(fn, "test-fn-write-err", "default");

    const result = await cached(taintedCtx);
    expect(result).toBe("result");

    // Wait a tick for the inline cache write to complete
    await new Promise((r) => setTimeout(r, 0));

    expect(reportedErrors).toHaveLength(1);
    expect(reportedErrors[0].error).toBe(writeError);
    expect(reportedErrors[0].category).toBe("cache-write");
  });

  it("produces separate cache entries for different hosts with same pathname/params", async () => {
    const mockStore = {
      getItem: vi.fn().mockResolvedValue(null),
      setItem: vi.fn().mockResolvedValue(undefined),
    };

    const mockHandleStore = {
      push: vi.fn(),
      settled: Promise.resolve(),
      getDataForSegment: vi.fn().mockReturnValue({}),
    };

    const waitUntilFns: Array<() => Promise<void>> = [];

    mockGetRequestContext.mockReturnValue({
      _cacheStore: mockStore,
      _cacheProfiles: { default: { ttl: 60 } },
      _handleStore: mockHandleStore,
      waitUntil: (fn: () => Promise<void>) => {
        waitUntilFns.push(fn);
      },
    });

    const fn = async (_ctx: any) => "result";
    const cached = registerCachedFunction(fn, "shared-fn", "default");

    // Call with host-a
    const ctxA = {
      [NOCACHE_SYMBOL]: true,
      params: { id: "1" },
      pathname: "/products",
      searchParams: new URLSearchParams(),
      url: new URL("https://host-a.example.com/products"),
    };
    await cached(ctxA);
    for (const f of waitUntilFns) await f();

    // Call with host-b (same pathname/params)
    const ctxB = {
      [NOCACHE_SYMBOL]: true,
      params: { id: "1" },
      pathname: "/products",
      searchParams: new URLSearchParams(),
      url: new URL("https://host-b.example.com/products"),
    };
    await cached(ctxB);
    for (const f of waitUntilFns.slice(1)) await f();

    // Both calls should miss (separate keys), so setItem is called twice
    expect(mockStore.setItem).toHaveBeenCalledTimes(2);
    const keyA = mockStore.setItem.mock.calls[0][0] as string;
    const keyB = mockStore.setItem.mock.calls[1][0] as string;
    expect(keyA).not.toBe(keyB);
  });

  it("produces separate cache entries for different route names with same pathname/params", async () => {
    const mockStore = {
      getItem: vi.fn().mockResolvedValue(null),
      setItem: vi.fn().mockResolvedValue(undefined),
    };

    const mockHandleStore = {
      push: vi.fn(),
      settled: Promise.resolve(),
      getDataForSegment: vi.fn().mockReturnValue({}),
    };

    const waitUntilFns: Array<() => Promise<void>> = [];

    mockGetRequestContext.mockReturnValue({
      _cacheStore: mockStore,
      _cacheProfiles: { default: { ttl: 60 } },
      _handleStore: mockHandleStore,
      waitUntil: (fn: () => Promise<void>) => {
        waitUntilFns.push(fn);
      },
    });

    const fn = async (_ctx: any) => "result";
    const cached = registerCachedFunction(fn, "shared-fn", "default");

    // Call with route name A
    const ctxA = {
      [NOCACHE_SYMBOL]: true,
      params: { slug: "hello" },
      pathname: "/articles/hello",
      searchParams: new URLSearchParams(),
      url: new URL("https://example.com/articles/hello"),
      _routeName: "blog.article",
    };
    await cached(ctxA);
    for (const f of waitUntilFns) await f();

    // Call with route name B (same pathname/params, different route scope)
    const ctxB = {
      [NOCACHE_SYMBOL]: true,
      params: { slug: "hello" },
      pathname: "/articles/hello",
      searchParams: new URLSearchParams(),
      url: new URL("https://example.com/articles/hello"),
      _routeName: "magazine.article",
    };
    await cached(ctxB);
    for (const f of waitUntilFns.slice(1)) await f();

    // Both calls should miss (separate keys), so setItem is called twice
    expect(mockStore.setItem).toHaveBeenCalledTimes(2);
    const keyA = mockStore.setItem.mock.calls[0][0] as string;
    const keyB = mockStore.setItem.mock.calls[1][0] as string;
    expect(keyA).not.toBe(keyB);
  });

  it("stamps RequestContext even when cached function has no tainted args", async () => {
    const INSIDE_CACHE_EXEC = Symbol.for("rango:inside-cache-exec");
    const waitUntilFns: Array<() => Promise<void>> = [];

    const mockStore = {
      getItem: vi.fn().mockResolvedValue(null),
      setItem: vi.fn().mockResolvedValue(undefined),
    };

    const requestCtxObj: any = {
      _cacheStore: mockStore,
      _cacheProfiles: { default: { ttl: 60 } },
      waitUntil: (fn: () => Promise<void>) => {
        waitUntilFns.push(fn);
      },
    };
    mockGetRequestContext.mockReturnValue(requestCtxObj);

    // No tainted args — plain string argument only
    let stampedDuringExec = false;
    const fn = async (locale: string) => {
      stampedDuringExec = INSIDE_CACHE_EXEC in requestCtxObj;
      return `theme-${locale}`;
    };

    const cached = registerCachedFunction(fn, "no-taint-fn", "default");
    await cached("en");

    // The guard must have been active during execution
    expect(stampedDuringExec).toBe(true);

    // After execution completes, the stamp must be removed
    expect(INSIDE_CACHE_EXEC in requestCtxObj).toBe(false);
  });

  it("does not stamp RequestContext during stale background revalidation", async () => {
    // RequestContext is intentionally not stamped in background revalidation
    // to avoid polluting the shared foreground context. The foreground miss
    // path already catches cookies()/headers() misuse on first execution.
    const INSIDE_CACHE_EXEC = Symbol.for("rango:inside-cache-exec");
    const waitUntilFns: Array<() => Promise<void>> = [];

    const mockStore = {
      getItem: vi.fn(),
      setItem: vi.fn().mockResolvedValue(undefined),
    };

    const requestCtxObj: any = {
      _cacheStore: mockStore,
      _cacheProfiles: { default: { ttl: 60, swr: 120 } },
      waitUntil: (fn: () => Promise<void>) => {
        waitUntilFns.push(fn);
      },
    };
    mockGetRequestContext.mockReturnValue(requestCtxObj);

    // Return stale cache entry
    mockStore.getItem.mockResolvedValueOnce({
      value: JSON.stringify("stale-theme"),
      shouldRevalidate: true,
    });

    let stampedDuringBgExec = false;
    const fn = async (locale: string) => {
      stampedDuringBgExec = INSIDE_CACHE_EXEC in requestCtxObj;
      return `fresh-theme-${locale}`;
    };

    const cached = registerCachedFunction(fn, "no-taint-stale", "default");
    const result = await cached("en");
    expect(result).toBe("stale-theme");

    // Run background revalidation
    expect(waitUntilFns).toHaveLength(1);
    await waitUntilFns[0]();

    // RequestContext must NOT be stamped in background (avoids foreground pollution)
    expect(stampedDuringBgExec).toBe(false);
    expect(INSIDE_CACHE_EXEC in requestCtxObj).toBe(false);
  });

  it("produces separate cache entries for different response types at the same URL", async () => {
    const mockStore = {
      getItem: vi.fn().mockResolvedValue(null),
      setItem: vi.fn().mockResolvedValue(undefined),
    };
    const mockHandleStore = {
      push: vi.fn(),
      settled: Promise.resolve(),
      getDataForSegment: vi.fn().mockReturnValue({}),
    };
    const waitUntilFns: Array<() => Promise<void>> = [];

    mockGetRequestContext.mockReturnValue({
      _cacheStore: mockStore,
      _cacheProfiles: { default: { ttl: 60 } },
      _handleStore: mockHandleStore,
      waitUntil: (fn: () => Promise<void>) => {
        waitUntilFns.push(fn);
      },
    });

    const fn = async (_ctx: any) => "result";
    const cached = registerCachedFunction(fn, "shared-fn", "default");

    // Same fn id, host, pathname, params — differ only by _responseType.
    const base = {
      [NOCACHE_SYMBOL]: true,
      params: { id: "1" },
      pathname: "/data/1",
      searchParams: new URLSearchParams(),
      url: new URL("https://example.com/data/1"),
    };
    await cached({ ...base, _responseType: "json" });
    for (const f of waitUntilFns) await f();
    await cached({ ...base, _responseType: "text" });
    for (const f of waitUntilFns.slice(1)) await f();

    expect(mockStore.setItem).toHaveBeenCalledTimes(2);
    const keyJson = mockStore.setItem.mock.calls[0][0] as string;
    const keyText = mockStore.setItem.mock.calls[1][0] as string;
    expect(keyJson).not.toBe(keyText);
  });

  it("throws at invocation when the cached function references an unknown profile", async () => {
    const mockStore = {
      getItem: vi.fn().mockResolvedValue(null),
      setItem: vi.fn().mockResolvedValue(undefined),
    };
    mockGetRequestContext.mockReturnValue({
      _cacheStore: mockStore,
      // The "typo" profile is not registered.
      _cacheProfiles: { default: { ttl: 60 } },
      waitUntil: (fn: () => Promise<void>) => fn(),
    });

    const fn = async () => "result";
    const cached = registerCachedFunction(fn, "needs-profile", "typo");

    await expect(cached()).rejects.toThrow(/uses unknown cache profile "typo"/);
    // The message points the author at the fix.
    await expect(cached()).rejects.toThrow(/cacheProfiles/);
    expect(mockStore.setItem).not.toHaveBeenCalled();
  });
});
