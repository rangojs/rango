/**
 * C1 userland-shaped coverage: a "use cache" function called twice with the
 * SAME binary (Uint8Array/Blob) argument must HIT on the second call (was: a
 * perpetual miss, because the FormData multipart boundary leaked into the key).
 *
 * This drives the PRODUCTION registerCachedFunction wrapper (the runtime the Vite
 * "use cache" transform emits) against a REAL MemorySegmentCacheStore, so the
 * full miss -> store -> hit round-trip runs through the binary replyToCacheKey
 * path. @vitejs/plugin-rsc/rsc and segment-codec are mocked because they are
 * virtual modules that the non-Vite unit runner cannot resolve — the SAME
 * reason a true end-to-end HIT through a public primitive (renderHandler/
 * runLoader calling a real "use cache" fn) is only reachable in the e2e tier
 * (render-handler.rsc-test.tsx pins only that the store reaches the request
 * context; the serializer is unresolvable even there). encodeReply is mocked to
 * the REAL FormData shape it emits for a typed-array arg so the binary-key
 * derivation under test actually executes.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// encodeReply emits FormData for a typed-array/Blob arg (per-call random
// boundary). Reproduce that shape so replyToCacheKey's binary branch runs.
vi.mock("@vitejs/plugin-rsc/rsc", () => ({
  encodeReply: vi.fn(async (args: unknown[]) => {
    const fd = new FormData();
    args.forEach((arg, i) => {
      if (arg instanceof Uint8Array) {
        fd.append(String(i), new Blob([arg.slice()], { type: "" }));
      } else if (arg instanceof Blob) {
        fd.append(String(i), arg);
      } else {
        fd.append(String(i), JSON.stringify(arg));
      }
    });
    return fd;
  }),
  createClientTemporaryReferenceSet: vi.fn(() => new Set()),
}));

// Identity codec — the value round-trips through the store unchanged.
vi.mock("../segment-codec.js", () => ({
  serializeResult: vi.fn(async (v: any) => JSON.stringify(v)),
  deserializeResult: vi.fn(async (v: string) => JSON.parse(v)),
}));

const mockGetRequestContext = vi.fn<() => any>(() => null);
vi.mock("../../server/request-context.js", () => ({
  getRequestContext: () => mockGetRequestContext(),
}));

vi.mock("../../internal-debug.js", () => ({ INTERNAL_RANGO_DEBUG: false }));

describe('"use cache" with a binary arg hits on the second identical call (C1)', () => {
  let registerCachedFunction: typeof import("../cache-runtime.js").registerCachedFunction;
  let MemorySegmentCacheStore: typeof import("../memory-segment-store.js").MemorySegmentCacheStore;

  beforeEach(async () => {
    vi.clearAllMocks();
    registerCachedFunction = (await import("../cache-runtime.js"))
      .registerCachedFunction;
    MemorySegmentCacheStore = (await import("../memory-segment-store.js"))
      .MemorySegmentCacheStore;
  });

  it("runs the body once for two calls with an identical Uint8Array arg", async () => {
    const store = new MemorySegmentCacheStore();
    const waitUntilFns: Array<() => Promise<void>> = [];
    mockGetRequestContext.mockReturnValue({
      _cacheStore: store,
      _cacheProfiles: { default: { ttl: 60, swr: 120 } },
      // The miss-path store write is scheduled via runBackground; capture it so
      // we can flush it before the second call reads.
      waitUntil: (fn: () => Promise<void>) => {
        waitUntilFns.push(fn);
      },
    });

    let calls = 0;
    const fn = async (_bytes: Uint8Array) => {
      calls++;
      return { value: `result-${calls}` };
    };
    const cached = registerCachedFunction(fn, "binary-fn", "default");

    // First call: MISS — body runs, result is stored under the binary key.
    const bytes1 = new Uint8Array([10, 20, 30, 40]);
    const first = await cached(bytes1);
    expect(first).toEqual({ value: "result-1" });
    // Flush the scheduled store write.
    await Promise.all(waitUntilFns.splice(0).map((f) => f()));

    // Second call with a DISTINCT-but-equal Uint8Array: HIT — body does NOT
    // re-run, the first result is served. Pre-fix this missed forever because
    // the per-call multipart boundary leaked into the key.
    const bytes2 = new Uint8Array([10, 20, 30, 40]);
    const second = await cached(bytes2);
    expect(second).toEqual({ value: "result-1" });
    expect(calls).toBe(1);
  });

  it("still MISSES for a different binary payload (distinct key)", async () => {
    const store = new MemorySegmentCacheStore();
    const waitUntilFns: Array<() => Promise<void>> = [];
    mockGetRequestContext.mockReturnValue({
      _cacheStore: store,
      _cacheProfiles: { default: { ttl: 60, swr: 120 } },
      waitUntil: (fn: () => Promise<void>) => {
        waitUntilFns.push(fn);
      },
    });

    let calls = 0;
    const fn = async (_bytes: Uint8Array) => {
      calls++;
      return { value: `result-${calls}` };
    };
    const cached = registerCachedFunction(fn, "binary-fn-2", "default");

    await cached(new Uint8Array([1, 2, 3]));
    await Promise.all(waitUntilFns.splice(0).map((f) => f()));
    const second = await cached(new Uint8Array([9, 9, 9]));
    await Promise.all(waitUntilFns.splice(0).map((f) => f()));

    // Different bytes -> different key -> the body re-runs (genuine miss).
    expect(second).toEqual({ value: "result-2" });
    expect(calls).toBe(2);
  });
});
