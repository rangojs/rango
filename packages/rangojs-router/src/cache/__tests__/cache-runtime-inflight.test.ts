/**
 * C1: in-flight dedup for concurrent "use cache" misses.
 *
 * When N concurrent calls miss on the SAME key, only the first (the leader)
 * runs the function; the rest await the leader's envelope (serialized value +
 * tags + encoded handles) and serve it as a synthetic hit — each deserializing
 * its OWN copy and replaying handles/tags against its OWN request. The store
 * write stays exactly once. A rejected leader clears the entry so the next call
 * retries fresh.
 *
 * Drives the production registerCachedFunction wrapper with the virtual
 * @vitejs/plugin-rsc/rsc + segment-codec modules mocked (they are unresolvable
 * in the non-Vite unit runner), same as the sibling cache-runtime suites.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NOCACHE_SYMBOL } from "../taint.js";

// encodeReply serializes args so JSON-safe args still exercise the wrapper; the
// fast-path key builder handles them without calling this in practice.
vi.mock("@vitejs/plugin-rsc/rsc", () => ({
  encodeReply: vi.fn((args: unknown[]) =>
    Promise.resolve(JSON.stringify(args)),
  ),
  createClientTemporaryReferenceSet: vi.fn().mockReturnValue(new Set()),
}));

const mockGetRequestContext = vi.fn<() => any>(() => null);
vi.mock("../../server/request-context.js", () => ({
  getRequestContext: () => mockGetRequestContext(),
  runWithRequestContext: <T>(_ctx: unknown, fn: () => T): T => fn(),
}));

// Identity codec: deserializeResult(serializeResult(v)) is a structurally-equal
// but DISTINCT copy — the followers must never share the leader's object.
vi.mock("../segment-codec.js", () => ({
  serializeResult: vi.fn(async (v: any) => JSON.stringify(v)),
  deserializeResult: vi.fn(async (v: string) => JSON.parse(v)),
}));

const mockRestoreHandles = vi.fn();
vi.mock("../handle-snapshot.js", () => ({
  restoreHandles: (...args: any[]) => mockRestoreHandles(...args),
  encodeHandles: vi.fn(async (h: any) => JSON.stringify(h)),
  decodeHandles: vi.fn(async (s: any) =>
    typeof s === "string" ? JSON.parse(s) : s,
  ),
}));

vi.mock("../../internal-debug.js", () => ({ INTERNAL_RANGO_DEBUG: false }));

describe('"use cache" in-flight dedup (C1)', () => {
  let registerCachedFunction: typeof import("../cache-runtime.js").registerCachedFunction;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockGetRequestContext.mockReturnValue(null);
    registerCachedFunction = (await import("../cache-runtime.js"))
      .registerCachedFunction;
  });

  // waitUntil that INVOKES the background task (as a real runtime does), so the
  // leader's envelope resolves and followers can serve it.
  function ctxWithInvokingWaitUntil(
    store: any,
    extra: Record<string, any> = {},
  ) {
    return {
      _cacheStore: store,
      _cacheProfiles: { default: { ttl: 60 } },
      waitUntil: (fn: () => Promise<void>) => {
        void fn();
      },
      ...extra,
    };
  }

  it("runs fn once for concurrent identical misses; both callers resolve correctly", async () => {
    const store = {
      getItem: vi.fn().mockResolvedValue(null),
      setItem: vi.fn().mockResolvedValue(undefined),
    };
    mockGetRequestContext.mockReturnValue(ctxWithInvokingWaitUntil(store));

    let calls = 0;
    const fn = async (_x: string) => {
      calls++;
      await Promise.resolve();
      return { value: `result-${calls}` };
    };
    const cached = registerCachedFunction(fn, "dedup-fn", "default");

    const [a, b] = await Promise.all([cached("same"), cached("same")]);

    expect(calls).toBe(1);
    expect(a).toEqual({ value: "result-1" });
    expect(b).toEqual({ value: "result-1" });
    // The leader returns its raw result; the follower deserializes its OWN copy.
    expect(a).not.toBe(b);
    // The store write happens exactly once (the leader's).
    expect(store.setItem).toHaveBeenCalledTimes(1);
  });

  it("does NOT dedup calls with different keys (fn runs per key)", async () => {
    const store = {
      getItem: vi.fn().mockResolvedValue(null),
      setItem: vi.fn().mockResolvedValue(undefined),
    };
    mockGetRequestContext.mockReturnValue(ctxWithInvokingWaitUntil(store));

    let calls = 0;
    const fn = async (_x: string) => {
      const n = ++calls;
      await Promise.resolve();
      return `r-${n}`;
    };
    const cached = registerCachedFunction(fn, "dedup-fn-2", "default");

    const [a, b] = await Promise.all([cached("A"), cached("B")]);

    expect(calls).toBe(2);
    expect(new Set([a, b])).toEqual(new Set(["r-1", "r-2"]));
    expect(store.setItem).toHaveBeenCalledTimes(2);
  });

  it("a rejected leader clears the entry so a later call re-runs fresh", async () => {
    const store = {
      getItem: vi.fn().mockResolvedValue(null),
      setItem: vi.fn().mockResolvedValue(undefined),
    };
    mockGetRequestContext.mockReturnValue(ctxWithInvokingWaitUntil(store));

    let calls = 0;
    const fn = async (_x: string) => {
      calls++;
      if (calls === 1) throw new Error("boom");
      return "ok";
    };
    const cached = registerCachedFunction(fn, "dedup-reject", "default");

    await expect(cached("x")).rejects.toThrow("boom");
    // The in-flight entry was cleared on rejection; a fresh call re-runs.
    await expect(cached("x")).resolves.toBe("ok");
    expect(calls).toBe(2);
    // The failed run wrote nothing; only the successful retry did.
    expect(store.setItem).toHaveBeenCalledTimes(1);
  });

  it("a rejected leader propagates to concurrent waiters, which then retry fresh", async () => {
    const store = {
      getItem: vi.fn().mockResolvedValue(null),
      setItem: vi.fn().mockResolvedValue(undefined),
    };
    mockGetRequestContext.mockReturnValue(ctxWithInvokingWaitUntil(store));

    let calls = 0;
    const fn = async (_x: string) => {
      const n = ++calls;
      await Promise.resolve();
      if (n === 1) throw new Error("boom");
      return `ok-${n}`;
    };
    const cached = registerCachedFunction(
      fn,
      "dedup-reject-concurrent",
      "default",
    );

    const settled = await Promise.allSettled([cached("x"), cached("x")]);
    const rejected = settled.filter((s) => s.status === "rejected");
    const fulfilled = settled.filter((s) => s.status === "fulfilled");

    // Exactly one leader rejected; the follower fell through and ran fresh.
    expect(rejected).toHaveLength(1);
    expect(fulfilled).toHaveLength(1);
    expect(calls).toBe(2);
  });

  it("delivers tags and handles to both the leader and the follower", async () => {
    const store = {
      getItem: vi.fn().mockResolvedValue(null),
      setItem: vi.fn().mockResolvedValue(undefined),
    };
    // Shared handle store (the mock returns one ctx for both concurrent calls);
    // startHandleCapture wraps its push so a push inside fn is captured.
    const handleStore = {
      push: vi.fn(),
      settled: Promise.resolve(),
      getDataForSegment: vi.fn().mockReturnValue({}),
    };
    const requestTags = new Set<string>();
    mockGetRequestContext.mockReturnValue({
      _cacheStore: store,
      _cacheProfiles: { tagged: { ttl: 60, tags: ["profile-tag"] } },
      _handleStore: handleStore,
      _requestTags: requestTags,
      waitUntil: (fn: () => Promise<void>) => {
        void fn();
      },
    });

    const { cacheTag } = await import("../cache-tag.js");
    const fn = async (_ctx: any) => {
      cacheTag("runtime-tag");
      // Pushed through the capture interceptor -> lands in the envelope handles.
      handleStore.push("crumb", "seg1", "hello");
      return "value";
    };
    const cached = registerCachedFunction(fn, "dedup-th", "tagged");

    const ctx = {
      [NOCACHE_SYMBOL]: true,
      params: { id: "1" },
      pathname: "/th",
      searchParams: new URLSearchParams(),
    };
    const [a, b] = await Promise.all([cached(ctx), cached(ctx)]);

    expect(a).toBe("value");
    expect(b).toBe("value");
    // Tags recorded into the request set by BOTH the leader (fresh execution)
    // and the follower (synthetic hit).
    expect(requestTags.has("profile-tag")).toBe(true);
    expect(requestTags.has("runtime-tag")).toBe(true);
    // The leader captured + stored handles once.
    expect(store.setItem).toHaveBeenCalledTimes(1);
    expect(store.setItem.mock.calls[0][2].handles).toBeDefined();
    // The follower replayed the same encoded handles into its handle store.
    expect(mockRestoreHandles).toHaveBeenCalled();
  });

  // Wedged-leader guard (production pilot incident): a leader that never settles —
  // e.g. registered by a background shell capture whose workerd context was
  // killed while its upstream fetch tarpitted — must not hang followers
  // forever. Followers trust an in-flight entry only for the leader trust
  // window; past it they evict the entry and run fresh.
  describe("leader trust window", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    function wedgedThenFresh() {
      let calls = 0;
      const fn = async (_x: string): Promise<unknown> => {
        if (++calls === 1) return new Promise<never>(() => {});
        return "fresh";
      };
      return { fn, calls: () => calls };
    }

    it("a follower stops waiting on a wedged leader at the window and runs fresh", async () => {
      const store = {
        getItem: vi.fn().mockResolvedValue(null),
        setItem: vi.fn().mockResolvedValue(undefined),
      };
      mockGetRequestContext.mockReturnValue(ctxWithInvokingWaitUntil(store));
      const { fn, calls } = wedgedThenFresh();
      const cached = registerCachedFunction(fn, "wedged-live", "default");

      const leader = cached("k");
      void leader.catch(() => {});
      // Let the leader's miss path register the in-flight entry.
      await vi.advanceTimersByTimeAsync(0);
      const follower = cached("k");

      await vi.advanceTimersByTimeAsync(15_001);
      await expect(follower).resolves.toBe("fresh");
      expect(calls()).toBe(2);
    });

    it("an already-expired leader entry is evicted on arrival with no wait", async () => {
      const store = {
        getItem: vi.fn().mockResolvedValue(null),
        setItem: vi.fn().mockResolvedValue(undefined),
      };
      mockGetRequestContext.mockReturnValue(ctxWithInvokingWaitUntil(store));
      const { fn, calls } = wedgedThenFresh();
      const cached = registerCachedFunction(fn, "wedged-expired", "default");

      const leader = cached("k");
      void leader.catch(() => {});
      await vi.advanceTimersByTimeAsync(15_001);

      await expect(cached("k")).resolves.toBe("fresh");
      expect(calls()).toBe(2);
    });

    it("a leader inside the trust window still dedups (no premature eviction)", async () => {
      const store = {
        getItem: vi.fn().mockResolvedValue(null),
        setItem: vi.fn().mockResolvedValue(undefined),
      };
      mockGetRequestContext.mockReturnValue(ctxWithInvokingWaitUntil(store));
      let calls = 0;
      let release!: (v: string) => void;
      const gate = new Promise<string>((r) => (release = r));
      const fn = async (_x: string) => {
        calls++;
        return await gate;
      };
      const cached = registerCachedFunction(fn, "wedged-healthy", "default");

      const leader = cached("k");
      await vi.advanceTimersByTimeAsync(0);
      const follower = cached("k");

      await vi.advanceTimersByTimeAsync(14_000);
      release("led");
      await vi.advanceTimersByTimeAsync(0);

      await expect(leader).resolves.toBe("led");
      await expect(follower).resolves.toBe("led");
      expect(calls).toBe(1);
      expect(store.setItem).toHaveBeenCalledTimes(1);
    });
  });
});
