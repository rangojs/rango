/**
 * C2: JSON-safe fast-path cache-key derivation.
 *
 * The cache key is built on EVERY call, including hits. When every key arg is
 * JSON-safe (primitives, plain objects/arrays of the same), a deterministic
 * stable-stringify builds the key and the React Flight reply encoder
 * (encodeReply) is skipped entirely. Non-JSON-safe args (functions, Dates,
 * React elements, ...) fall back to the encoder path unchanged.
 *
 * Drives the production registerCachedFunction wrapper against a REAL
 * MemorySegmentCacheStore so the miss -> store -> hit round-trip proves key
 * stability; @vitejs/plugin-rsc/rsc and segment-codec are mocked (virtual
 * modules the unit runner cannot resolve). encodeReply is a spy so the test can
 * assert whether the fast path or the encoder path ran.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NOCACHE_SYMBOL } from "../taint.js";

const encodeReply = vi.fn(async (args: unknown[], _opts?: unknown) =>
  JSON.stringify(args),
);
vi.mock("@vitejs/plugin-rsc/rsc", () => ({
  encodeReply: (args: unknown[], opts: unknown) => encodeReply(args, opts),
  createClientTemporaryReferenceSet: vi.fn(() => new Set()),
}));

vi.mock("../segment-codec.js", () => ({
  serializeResult: vi.fn(async (v: any) => JSON.stringify(v)),
  deserializeResult: vi.fn(async (v: string) => JSON.parse(v)),
}));

const mockGetRequestContext = vi.fn<() => any>(() => null);
vi.mock("../../server/request-context.js", () => ({
  getRequestContext: () => mockGetRequestContext(),
  runWithRequestContext: <T>(_ctx: unknown, fn: () => T): T => fn(),
}));

vi.mock("../../internal-debug.js", () => ({ INTERNAL_RANGO_DEBUG: false }));

describe('"use cache" JSON-safe fast-path key (C2)', () => {
  let registerCachedFunction: typeof import("../cache-runtime.js").registerCachedFunction;
  let MemorySegmentCacheStore: typeof import("../memory-segment-store.js").MemorySegmentCacheStore;
  let waitUntilFns: Array<() => Promise<void>>;

  beforeEach(async () => {
    vi.clearAllMocks();
    registerCachedFunction = (await import("../cache-runtime.js"))
      .registerCachedFunction;
    MemorySegmentCacheStore = (await import("../memory-segment-store.js"))
      .MemorySegmentCacheStore;
    waitUntilFns = [];
  });

  function seedCtx(store: any, extra: Record<string, any> = {}) {
    mockGetRequestContext.mockReturnValue({
      _cacheStore: store,
      _cacheProfiles: { default: { ttl: 60, swr: 120 } },
      waitUntil: (fn: () => Promise<void>) => {
        waitUntilFns.push(fn);
      },
      ...extra,
    });
  }
  const flush = async () => Promise.all(waitUntilFns.splice(0).map((f) => f()));

  it("hits on the second call with identical JSON-safe args, without encodeReply", async () => {
    const store = new MemorySegmentCacheStore();
    seedCtx(store);

    let calls = 0;
    const fn = async (_arg: { a: number; b: string }) => {
      calls++;
      return { value: `r-${calls}` };
    };
    const cached = registerCachedFunction(fn, "fast-obj", "default");

    const first = await cached({ a: 1, b: "x" });
    await flush();
    const second = await cached({ a: 1, b: "x" });

    expect(first).toEqual({ value: "r-1" });
    expect(second).toEqual({ value: "r-1" }); // HIT: same key
    expect(calls).toBe(1);
    // Fast path: the Flight reply encoder was never invoked.
    expect(encodeReply).not.toHaveBeenCalled();
  });

  it("object key ORDER does not change the key (sorted stable-stringify)", async () => {
    const store = new MemorySegmentCacheStore();
    seedCtx(store);

    let calls = 0;
    const fn = async (_arg: Record<string, number>) => {
      calls++;
      return calls;
    };
    const cached = registerCachedFunction(fn, "fast-order", "default");

    await cached({ a: 1, b: 2 });
    await flush();
    const second = await cached({ b: 2, a: 1 }); // reordered keys -> same key

    expect(second).toBe(1); // HIT
    expect(calls).toBe(1);
    expect(encodeReply).not.toHaveBeenCalled();
  });

  it("different args produce different keys (miss)", async () => {
    const store = new MemorySegmentCacheStore();
    seedCtx(store);

    let calls = 0;
    const fn = async (_arg: { a: number }) => {
      const n = ++calls;
      return n;
    };
    const cached = registerCachedFunction(fn, "fast-diff", "default");

    await cached({ a: 1 });
    await flush();
    const second = await cached({ a: 2 });
    await flush();

    expect(second).toBe(2); // MISS: different key -> re-ran
    expect(calls).toBe(2);
    expect(encodeReply).not.toHaveBeenCalled();
  });

  it("falls back to the encodeReply path for a Date arg", async () => {
    const store = new MemorySegmentCacheStore();
    seedCtx(store);
    const fn = async (_d: Date) => "ok";
    const cached = registerCachedFunction(fn, "fallback-date", "default");

    await cached(new Date(1_700_000_000_000));
    expect(encodeReply).toHaveBeenCalledTimes(1);
  });

  it("falls back to the encodeReply path for a function arg", async () => {
    const store = new MemorySegmentCacheStore();
    seedCtx(store);
    const fn = async (_cb: () => void) => "ok";
    const cached = registerCachedFunction(fn, "fallback-fn", "default");

    await cached(() => {});
    expect(encodeReply).toHaveBeenCalledTimes(1);
  });

  it("falls back to the encodeReply path for a React-element-shaped arg (symbol value)", async () => {
    const store = new MemorySegmentCacheStore();
    seedCtx(store);
    const fn = async (_el: unknown) => "ok";
    const cached = registerCachedFunction(fn, "fallback-element", "default");

    // A React element is a plain object whose $$typeof value is a symbol.
    const element = {
      $$typeof: Symbol.for("react.element"),
      type: "div",
      props: {},
    };
    await cached(element);
    expect(encodeReply).toHaveBeenCalledTimes(1);
  });

  it("tainted-ctx-derived key args stay on the fast path and differ per pathname/params", async () => {
    const store = new MemorySegmentCacheStore();
    const handleStore = {
      push: vi.fn(),
      settled: Promise.resolve(),
      getDataForSegment: vi.fn().mockReturnValue({}),
    };
    seedCtx(store, { _handleStore: handleStore });

    let calls = 0;
    const fn = async (_ctx: any) => {
      const n = ++calls;
      return `r-${n}`;
    };
    const cached = registerCachedFunction(fn, "fast-tainted", "default");

    const base = {
      [NOCACHE_SYMBOL]: true,
      searchParams: new URLSearchParams(),
      url: new URL("https://example.com/x"),
    };
    // Same fn, different params -> distinct keys -> both miss.
    await cached({ ...base, params: { id: "1" }, pathname: "/p/1" });
    await flush();
    await cached({ ...base, params: { id: "2" }, pathname: "/p/2" });
    await flush();
    // Identical params/pathname -> HIT (fast key is stable).
    const hit = await cached({
      ...base,
      params: { id: "1" },
      pathname: "/p/1",
    });

    expect(calls).toBe(2); // two distinct keys, then a hit
    expect(hit).toBe("r-1");
    // Route-derived key args are JSON-safe: the encoder was never used.
    expect(encodeReply).not.toHaveBeenCalled();
  });
});
