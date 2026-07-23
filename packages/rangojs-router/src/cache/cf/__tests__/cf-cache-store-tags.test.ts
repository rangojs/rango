import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  CFCacheStore,
  KV_READ_TIMEOUT_MS,
  TAG_MARKER_PREFIX,
} from "../cf-cache-store";
import type { CachedEntryData } from "../../types";
import {
  createRequestContext,
  runWithRequestContext,
} from "../../../server/request-context";
import {
  CACHE_READ_ERROR,
  type CacheReadError as CacheReadErrorT,
} from "../../types.js";

// get() may return CACHE_READ_ERROR (backend failure, distinct from a miss);
// these tests assert hit/miss shapes, so narrow the sentinel away up front.
function hit(
  r: import("../../types.js").CacheGetResult | null | CacheReadErrorT,
): import("../../types.js").CacheGetResult | null {
  return r === CACHE_READ_ERROR ? null : r;
}

function makeReqCtx() {
  return createRequestContext({
    env: {},
    request: new Request("https://test.internal/"),
    url: new URL("https://test.internal/"),
    variables: {},
  });
}

// ============================================================================
// Mock Cloudflare Cache API (L1) + KV (L2)
// ============================================================================

// Honors Cache-Control max-age against the (fake) clock so tagCacheTtl expiry is
// actually exercised. A real Cache API may evict earlier, but never serves an
// entry past its max-age - which is the property the marker-TTL relies on.
class MockCache {
  private store = new Map<string, { response: Response; expiresAt: number }>();
  async match(request: Request): Promise<Response | undefined> {
    const entry = this.store.get(request.url);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(request.url);
      return undefined;
    }
    return entry.response.clone();
  }
  async put(request: Request, response: Response): Promise<void> {
    const cc = response.headers.get("Cache-Control") ?? "";
    const m = /max-age=(\d+)/.exec(cc);
    const maxAge = m ? Number(m[1]) : Number.POSITIVE_INFINITY;
    this.store.set(request.url, {
      response: response.clone(),
      expiresAt: Date.now() + maxAge * 1000,
    });
  }
  async delete(request: Request): Promise<boolean> {
    return this.store.delete(request.url);
  }
  clear(): void {
    this.store.clear();
  }
}

class MockCaches {
  _default = new MockCache();
  async open(): Promise<MockCache> {
    return this._default;
  }
  get default(): MockCache {
    return this._default;
  }
  clear(): void {
    this._default.clear();
  }
}

class MockKV {
  store = new Map<string, string>();
  async get(key: string, options?: { type?: string }): Promise<any> {
    const raw = this.store.get(key);
    if (raw === undefined) return null;
    return options?.type === "json" ? JSON.parse(raw) : raw;
  }
  async put(
    key: string,
    value: string,
    _options?: { expirationTtl?: number },
  ): Promise<void> {
    this.store.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
  clear(): void {
    this.store.clear();
  }
}

const mockCaches = new MockCaches();
(globalThis as any).caches = mockCaches;

// ExecutionContext mock that collects waitUntil promises so tests can flush them.
function createMockCtx() {
  const pending: Promise<any>[] = [];
  return {
    waitUntil: (p: Promise<any>) => {
      pending.push(Promise.resolve(p));
    },
    passThroughOnException: () => {},
    flush: async () => {
      while (pending.length) {
        const batch = pending.splice(0);
        await Promise.all(batch);
      }
    },
  };
}

const createTestData = (tags?: string[]): CachedEntryData => ({
  segments: [
    {
      encoded: "c",
      metadata: {
        id: "seg",
        type: "route",
        namespace: "test",
        index: 0,
        params: {},
      },
    },
  ],
  handles: "",
  expiresAt: Date.now() + 60_000,
  tags,
});

describe("CFCacheStore tag invalidation (single-store)", () => {
  let ctx: ReturnType<typeof createMockCtx>;
  let kv: MockKV;

  beforeEach(() => {
    // Restore spies between tests so a persistent mock (e.g. a mockRejectedValue
    // on cache.put from a write-failure test) cannot leak into later tests and
    // silently drop L1 writes. Mirrors the cf-cache-store.test.ts beforeEach.
    vi.restoreAllMocks();
    mockCaches.clear();
    kv = new MockKV();
    ctx = createMockCtx();
    vi.useFakeTimers();
  });

  afterEach(() => {
    // Restore real timers so a fake-timer install can never leak past this file
    // if vitest's per-file isolation is ever relaxed (e.g. a shared pool).
    vi.useRealTimers();
  });

  function makeStore(overrides: Record<string, unknown> = {}) {
    return new CFCacheStore({
      ctx: ctx as any,
      kv: kv as any,
      baseUrl: "https://test.internal/",
      version: "v1",
      ...overrides,
    });
  }

  describe("segment entries", () => {
    it("invalidateTag drops a tagged segment from L1", async () => {
      const store = makeStore();
      await store.set("k", createTestData(["products"]), 300);
      await ctx.flush();

      expect(hit(await store.get("k"))).not.toBeNull();

      vi.advanceTimersByTime(10);
      await store.invalidateTags(["products"]);

      expect(hit(await store.get("k"))).toBeNull();
    });

    it("leaves untagged segments untouched", async () => {
      const store = makeStore();
      await store.set("k", createTestData(), 300);
      await ctx.flush();

      await store.invalidateTags(["products"]);
      expect(hit(await store.get("k"))).not.toBeNull();
    });

    it("does not invalidate an entry tagged AFTER the invalidation", async () => {
      const store = makeStore();
      await store.invalidateTags(["products"]);

      vi.advanceTimersByTime(10);
      await store.set("k", createTestData(["products"]), 300);
      await ctx.flush();

      // taggedAt is now newer than the invalidation marker -> still a hit.
      expect(hit(await store.get("k"))).not.toBeNull();
    });
  });

  describe("function items", () => {
    it("invalidateTag drops a tagged item", async () => {
      const store = makeStore();
      await store.setItem("k", "v", { ttl: 300, tags: ["catalog"] });
      await ctx.flush();

      expect(await store.getItem("k")).not.toBeNull();

      vi.advanceTimersByTime(10);
      await store.invalidateTags(["catalog"]);
      expect(await store.getItem("k")).toBeNull();
    });

    it("preserves tags across KV->L1 promotion (regression: item tier tag loss)", async () => {
      const store = makeStore();
      await store.setItem("k", "v", { ttl: 300, tags: ["catalog"] });
      await ctx.flush();

      // Evict L1 only; KV (L2) still holds the entry.
      mockCaches.clear();

      // Read falls back to KV, returns the value, and promotes back to L1.
      expect(await store.getItem("k")).not.toBeNull();
      await ctx.flush();

      // The promoted L1 entry must still carry its tags, so invalidation works.
      vi.advanceTimersByTime(10);
      await store.invalidateTags(["catalog"]);
      expect(await store.getItem("k")).toBeNull();
    });

    it("invalidates a KV-tier item that was never promoted", async () => {
      const store = makeStore();
      await store.setItem("k", "v", { ttl: 300, tags: ["catalog"] });
      await ctx.flush();
      mockCaches.clear(); // L1 gone, only KV remains

      vi.advanceTimersByTime(10);
      await store.invalidateTags(["catalog"]);

      // KV read path must honor the invalidation marker.
      expect(await store.getItem("k")).toBeNull();
    });
  });

  describe("document responses", () => {
    it("invalidateTag drops a tagged response", async () => {
      const store = makeStore();
      await store.putResponse!(
        "k",
        new Response("body", { status: 200 }),
        300,
        0,
        ["page"],
      );
      await ctx.flush();

      expect(await store.getResponse!("k")).not.toBeNull();

      vi.advanceTimersByTime(10);
      await store.invalidateTags(["page"]);
      expect(await store.getResponse!("k")).toBeNull();
    });

    it("does not leak internal tag headers to the client", async () => {
      const store = makeStore();
      await store.putResponse!(
        "k",
        new Response("body", { status: 200 }),
        300,
        0,
        ["page"],
      );
      await ctx.flush();

      const hit = await store.getResponse!("k");
      expect(hit).not.toBeNull();
      expect(hit!.response.headers.get("x-edge-cache-tags")).toBeNull();
      expect(hit!.response.headers.get("x-edge-cache-tagged-at")).toBeNull();
    });
  });

  describe("invalidateTag configuration", () => {
    it("warns and no-ops when neither KV nor onRevalidateTag is configured", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const store = new CFCacheStore({
        ctx: ctx as any,
        baseUrl: "https://test.internal/",
      });
      await store.invalidateTags(["x"]);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("had no effect"),
      );
      warn.mockRestore();
    });

    it("fires onRevalidateTag ONCE per call with the batched, namespaced purge tags", async () => {
      const onRevalidateTag = vi.fn(async () => {});
      const store = makeStore({ namespace: "shop", onRevalidateTag });
      await store.invalidateTags(["products", "catalog"]);
      // One batched call (not one per tag), with the namespaced lookup tags that
      // match the Cache-Tag headers written on the marker entries.
      expect(onRevalidateTag).toHaveBeenCalledTimes(1);
      expect(onRevalidateTag).toHaveBeenCalledWith([
        "rg:shop:lk:products",
        "rg:shop:lk:catalog",
      ]);
    });

    it("encodes commas/spaces in purge tags so the Cache-Tag header stays valid", async () => {
      const onRevalidateTag = vi.fn(async () => {});
      const store = makeStore({ onRevalidateTag });
      await store.invalidateTags(["a,b c"]);
      expect(onRevalidateTag).toHaveBeenCalledWith(["rg:default:lk:a%2Cb%20c"]);
    });

    it("writes NO L1 marker and no read-consulted memo when KV is absent (write-through is dead state without KV)", async () => {
      // Markers are read only through isGloballyInvalidated(), which short-circuits
      // on !this.kv. With no KV, a memo/L1 marker write would be state no read path
      // ever consults, so invalidateTags must not emit it - even with tagCacheTtl>0
      // (which otherwise exercises the L1 marker put) and an onRevalidateTag hook
      // present so the no-kv-no-hook warning stays silent.
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const putSpy = vi.spyOn(mockCaches._default, "put");
      const store = new CFCacheStore({
        ctx: ctx as any,
        baseUrl: "https://test.internal/",
        // Unique namespace: the no-kv warning de-dupes once per namespace at the
        // module level, so reusing "default" would silently consume that slot for
        // the rest of the process and couple this test to others' ordering.
        namespace: "no-kv-warn-fixture",
        tagCacheTtl: 60,
        onRevalidateTag: async () => {},
      });

      await runWithRequestContext(makeReqCtx(), async () => {
        await store.invalidateTags(["t"]);

        // A within-request tagged read must NOT see an invalidation: without KV
        // there is no marker the read can consult, so the entry survives.
        await store.setItem("k", "v", { ttl: 300, tags: ["t"] });
        await ctx.flush();
        expect(await store.getItem("k")).not.toBeNull();
      });

      // No L1 Cache API marker put for the __tagmarker__/ key.
      const markerPut = putSpy.mock.calls.find(([req]) =>
        decodeURIComponent((req as Request).url).includes("__tagmarker__/t"),
      );
      expect(markerPut).toBeUndefined();
      putSpy.mockRestore();
      warn.mockRestore();
    });
  });

  describe("per-request marker memo", () => {
    it("reads a tag's KV marker at most once per request across many tagged reads", async () => {
      const store = makeStore();
      await store.set("k1", createTestData(["shared"]), 300);
      await store.set("k2", createTestData(["shared"]), 300);
      await ctx.flush();

      const getSpy = vi.spyOn(kv, "get");
      await runWithRequestContext(makeReqCtx(), async () => {
        hit(await store.get("k1"));
        hit(await store.get("k2"));
        hit(await store.get("k1"));
      });

      // Three reads of "shared"-tagged entries -> exactly one marker KV read.
      const markerReads = getSpy.mock.calls.filter(([key]) =>
        String(key).includes("__tag__/shared"),
      );
      expect(markerReads.length).toBe(1);
      getSpy.mockRestore();
    });

    it("stays read-your-own-writes when updateTag runs mid-request (write-through)", async () => {
      const store = makeStore();
      await store.setItem("k", "v", { ttl: 300, tags: ["catalog"] });
      await ctx.flush();

      await runWithRequestContext(makeReqCtx(), async () => {
        // First read memoizes "catalog" -> no marker yet.
        expect(await store.getItem("k")).not.toBeNull();
        // Invalidate within the same request; without write-through the memo
        // would still say "no marker" and serve the stale entry below.
        vi.advanceTimersByTime(10);
        await store.invalidateTags(["catalog"]);
        expect(await store.getItem("k")).toBeNull();
      });
    });
  });

  describe("L1 marker cache (tagCacheTtl)", () => {
    it("default (tagCacheTtl=0) reads the KV marker on every request (no L1 cache)", async () => {
      const store = makeStore(); // tagCacheTtl defaults to 0
      await store.set("k", createTestData(["shared"]), 300);
      await ctx.flush();

      const getSpy = vi.spyOn(kv, "get");
      await runWithRequestContext(makeReqCtx(), () => store.get("k"));
      await runWithRequestContext(makeReqCtx(), () => store.get("k"));

      const markerReads = getSpy.mock.calls.filter(([key]) =>
        String(key).includes("__tag__/shared"),
      );
      expect(markerReads.length).toBe(2); // one KV read per request, no L1 cache
      getSpy.mockRestore();
    });

    it("caches the marker in L1 across requests within tagCacheTtl (one KV read)", async () => {
      const store = makeStore({ tagCacheTtl: 60 });
      await store.set("k", createTestData(["shared"]), 300);
      await ctx.flush();

      const getSpy = vi.spyOn(kv, "get");
      await runWithRequestContext(makeReqCtx(), () => store.get("k"));
      await ctx.flush(); // L1 populate (non-blocking via waitUntil)
      await runWithRequestContext(makeReqCtx(), () => store.get("k"));

      const markerReads = getSpy.mock.calls.filter(([key]) =>
        String(key).includes("__tag__/shared"),
      );
      expect(markerReads.length).toBe(1); // second request served the marker from L1
      getSpy.mockRestore();
    });

    it("re-reads the KV marker after tagCacheTtl expires", async () => {
      const store = makeStore({ tagCacheTtl: 60 });
      await store.set("k", createTestData(["shared"]), 300);
      await ctx.flush();

      const getSpy = vi.spyOn(kv, "get");
      await runWithRequestContext(makeReqCtx(), () => store.get("k"));
      await ctx.flush();
      vi.advanceTimersByTime(61_000); // past the 60s marker TTL (data ttl is 300s)
      await runWithRequestContext(makeReqCtx(), () => store.get("k"));

      const markerReads = getSpy.mock.calls.filter(([key]) =>
        String(key).includes("__tag__/shared"),
      );
      expect(markerReads.length).toBe(2);
      getSpy.mockRestore();
    });

    it("write-through on invalidate: originating colo sees it immediately despite a cached absent marker", async () => {
      const store = makeStore({ tagCacheTtl: 60 });
      await store.set("k", createTestData(["shared"]), 300);
      await ctx.flush();

      // Prime L1 with the "no marker yet" (absent) sentinel for "shared".
      await runWithRequestContext(makeReqCtx(), async () => {
        expect(hit(await store.get("k"))).not.toBeNull();
      });
      await ctx.flush();

      // Invalidate: write-through must overwrite the cached absent sentinel.
      vi.advanceTimersByTime(10);
      await store.invalidateTags(["shared"]);

      // A later request in the SAME colo, still within the 60s window, must see
      // the invalidation (a delete-then-rely-on-KV approach would serve stale).
      await runWithRequestContext(makeReqCtx(), async () => {
        expect(hit(await store.get("k"))).toBeNull();
      });
    });

    it("writes the namespaced Cache-Tag tiers on the L1 marker entry (purgeable)", async () => {
      const store = makeStore({ namespace: "shop", tagCacheTtl: 60 });
      await store.set("k", createTestData(["products"]), 300);
      await ctx.flush();

      const putSpy = vi.spyOn(mockCaches._default, "put");
      await runWithRequestContext(makeReqCtx(), () => store.get("k"));
      await ctx.flush(); // marker L1 populate

      const markerPut = putSpy.mock.calls.find(([req]) =>
        decodeURIComponent((req as Request).url).includes(
          "__tagmarker__/products",
        ),
      );
      expect(markerPut).toBeDefined();
      const cacheTag = (markerPut![1] as Response).headers.get("Cache-Tag");
      // Three tiers: nuclear, all-lookups, this-tag (the purge target).
      expect(cacheTag).toBe("rg:shop,rg:shop:lk,rg:shop:lk:products");
      putSpy.mockRestore();
    });

    it("write-through fans out an L1 marker for EVERY invalidated tag, not just the last", async () => {
      // Guards the per-tag fan-out (Promise.all over tags). An off-by-one that
      // only wrote the last tag's marker would still pass single-tag tests.
      const store = makeStore({ tagCacheTtl: 60 });
      const putSpy = vi.spyOn(mockCaches._default, "put");

      await runWithRequestContext(makeReqCtx(), () =>
        store.invalidateTags(["alpha", "beta", "gamma"]),
      );
      await ctx.flush();

      const markerWritten = (tag: string) =>
        putSpy.mock.calls.some(([req]) =>
          decodeURIComponent((req as Request).url).includes(
            `__tagmarker__/${tag}`,
          ),
        );
      expect(markerWritten("alpha")).toBe(true);
      expect(markerWritten("beta")).toBe(true);
      expect(markerWritten("gamma")).toBe(true);
      putSpy.mockRestore();
    });
  });

  describe("non-Latin1 tags (header ByteString safety)", () => {
    it("caches and invalidates an entry tagged with CJK/emoji (does not silently drop it)", async () => {
      const store = makeStore();
      // Without encoding, JSON.stringify(["商品","🛒"]) in an HTTP header throws a
      // ByteString error, the outer try/catch swallows it, and the entry is never
      // cached - diverging silently from MemorySegmentCacheStore.
      await store.set("k", createTestData(["商品", "🛒"]), 300);
      await ctx.flush();

      expect(hit(await store.get("k"))).not.toBeNull();

      vi.advanceTimersByTime(10);
      await store.invalidateTags(["商品"]);
      expect(hit(await store.get("k"))).toBeNull();
    });

    it("round-trips emoji tags through an item entry", async () => {
      const store = makeStore();
      await store.setItem("k", "v", { ttl: 300, tags: ["🛒catalog"] });
      await ctx.flush();
      expect(await store.getItem("k")).not.toBeNull();

      vi.advanceTimersByTime(10);
      await store.invalidateTags(["🛒catalog"]);
      expect(await store.getItem("k")).toBeNull();
    });
  });

  describe("durable-write integrity (updateTag honesty)", () => {
    it("rejects when a tag's KV marker write fails (does not report success)", async () => {
      const store = makeStore();
      await store.setItem("k", "v", { ttl: 300, tags: ["products"] });
      await ctx.flush();

      // Fail only the marker write; data writes still succeed.
      vi.spyOn(kv, "put").mockImplementation(
        async (key: string, value: string) => {
          if (key.includes("__tag__/")) throw new Error("KV unavailable");
          kv.store.set(key, value);
        },
      );

      await expect(store.invalidateTags(["products"])).rejects.toThrow(
        /tag marker write\(s\) failed/,
      );
    });

    it("does not write-through the memo for a tag whose durable write failed", async () => {
      const store = makeStore();
      await store.setItem("k", "v", { ttl: 300, tags: ["products"] });
      await ctx.flush();

      vi.spyOn(kv, "put").mockImplementation(
        async (key: string, value: string) => {
          if (key.includes("__tag__/")) throw new Error("KV unavailable");
          kv.store.set(key, value);
        },
      );

      await runWithRequestContext(makeReqCtx(), async () => {
        expect(await store.getItem("k")).not.toBeNull();
        vi.advanceTimersByTime(10);
        // Rejects, and crucially must NOT poison the memo with a phantom success:
        // a masked failure would make the same-request read below return null.
        await expect(store.invalidateTags(["products"])).rejects.toThrow();
        expect(await store.getItem("k")).not.toBeNull();
      });
    });

    it("normalizes a tag exceeding the 512-byte KV key limit and invalidation round-trips", async () => {
      // Formerly rejected up front; toKVKey now normalizes the marker key
      // (preserved prefix + digest), and the marker READ derives the key the
      // same way, so an oversized tag invalidates instead of erroring.
      const store = makeStore();
      const hugeTag = "x".repeat(600);
      const putSpy = vi.spyOn(kv, "put");

      await store.set("hk", createTestData([hugeTag]), 300);
      await ctx.flush();
      expect(hit(await store.get("hk"))).not.toBeNull();

      vi.advanceTimersByTime(10);
      await expect(store.invalidateTags([hugeTag])).resolves.not.toThrow();

      const markerPuts = putSpy.mock.calls.filter(([key]) =>
        String(key).includes(TAG_MARKER_PREFIX),
      );
      expect(markerPuts.length).toBe(1);
      const markerKey = String(markerPuts[0]![0]);
      expect(markerKey.length).toBeLessThanOrEqual(512);
      expect(markerKey).toMatch(/~[0-9a-f]{32}$/);

      // The entry tagged with the huge tag is actually invalidated.
      expect(hit(await store.get("hk"))).toBeNull();
      putSpy.mockRestore();
    });
  });

  describe("cross-tag isolation", () => {
    it("invalidating one tag leaves an entry under a DIFFERENT tag intact", async () => {
      const store = makeStore();
      await store.set("ka", createTestData(["tag-a"]), 300);
      await store.set("kb", createTestData(["tag-b"]), 300);
      await ctx.flush();

      expect(hit(await store.get("ka"))).not.toBeNull();
      expect(hit(await store.get("kb"))).not.toBeNull();

      vi.advanceTimersByTime(10);
      await store.invalidateTags(["tag-a"]);

      // The marker is per-tag: only tag-a's entry is a miss; tag-b survives. A
      // regression that consulted a broader marker tier would over-invalidate kb.
      expect(hit(await store.get("ka"))).toBeNull();
      expect(hit(await store.get("kb"))).not.toBeNull();
    });

    it("invalidating one tag leaves a DIFFERENT-tagged item and response intact", async () => {
      const store = makeStore();
      await store.setItem("ia", "va", { ttl: 300, tags: ["tag-a"] });
      await store.setItem("ib", "vb", { ttl: 300, tags: ["tag-b"] });
      await store.putResponse!("ra", new Response("a"), 300, 0, ["tag-a"]);
      await store.putResponse!("rb", new Response("b"), 300, 0, ["tag-b"]);
      await ctx.flush();

      vi.advanceTimersByTime(10);
      await store.invalidateTags(["tag-a"]);

      expect(await store.getItem("ia")).toBeNull();
      expect(await store.getItem("ib")).not.toBeNull();
      expect(await store.getResponse!("ra")).toBeNull();
      expect(await store.getResponse!("rb")).not.toBeNull();
    });
  });

  describe("misconfiguration warnings (N1)", () => {
    it("warns when tagCacheTtl is set without a KV namespace", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      new CFCacheStore({
        ctx: ctx as any,
        baseUrl: "https://test.internal/",
        namespace: "n1-ttl",
        tagCacheTtl: 60,
      });
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("NO read-side effect"),
      );
      warn.mockRestore();
    });

    it("warns when onRevalidateTag is wired without a KV namespace", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      new CFCacheStore({
        ctx: ctx as any,
        baseUrl: "https://test.internal/",
        namespace: "n1-hook",
        onRevalidateTag: async () => {},
      });
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("NO read-side effect"),
      );
      warn.mockRestore();
    });

    it("does not warn when KV is configured", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      makeStore({
        namespace: "n1-ok",
        tagCacheTtl: 60,
        onRevalidateTag: async () => {},
      });
      expect(warn).not.toHaveBeenCalledWith(
        expect.stringContaining("NO read-side effect"),
      );
      warn.mockRestore();
    });
  });

  describe("concurrent marker reads (N2 in-flight dedup)", () => {
    it("collapses parallel reads of the same tag to a single KV marker read", async () => {
      const store = makeStore(); // tagCacheTtl=0 -> straight to KV
      await store.set("k1", createTestData(["shared"]), 300);
      await store.set("k2", createTestData(["shared"]), 300);
      await ctx.flush();

      const getSpy = vi.spyOn(kv, "get");
      await runWithRequestContext(makeReqCtx(), async () => {
        // Parallel (not sequential) reads: the resolved-value memo alone would
        // not collapse these, so each would issue its own marker KV read.
        await Promise.all([store.get("k1"), store.get("k2")]);
      });

      const markerReads = getSpy.mock.calls.filter(([key]) =>
        String(key).includes("__tag__/shared"),
      );
      expect(markerReads.length).toBe(1);
      getSpy.mockRestore();
    });
  });

  describe("error resilience (report onError + degrade + self-heal)", () => {
    function ctxWithReporter() {
      const reported: Array<{ error: unknown; category: string }> = [];
      const reqCtx = makeReqCtx();
      (reqCtx as any)._reportBackgroundError = (
        error: unknown,
        category: string,
      ) => reported.push({ error, category });
      return { reqCtx, reported };
    }

    it("reports a read infra error via onError and degrades (does not throw)", async () => {
      const store = makeStore();
      await store.set("k", createTestData(), 300);
      await ctx.flush();
      // Isolate the L1 tier: clear KV so the L1 match error has no L2 copy to
      // fall through to, and the read resolves to a clean miss. The resilient
      // case (L1 error but KV still serves the entry) is covered separately.
      kv.clear();

      vi.spyOn(mockCaches._default, "match").mockRejectedValueOnce(
        new Error("cache api unavailable"),
      );
      const delSpy = vi.spyOn(mockCaches._default, "delete");
      const { reqCtx, reported } = ctxWithReporter();
      const result = hit(
        await runWithRequestContext(reqCtx, () => store.get("k")),
      );

      expect(result).toBeNull(); // L1 error -> L2 (empty) -> miss, no throw
      expect(reported.some((r) => r.category === "cache-read")).toBe(true);
      // A transient L1 error must NOT be mistaken for corruption: the entry is
      // left intact (no eviction), unlike the cache-corrupt self-heal path.
      expect(reported.some((r) => r.category === "cache-corrupt")).toBe(false);
      expect(delSpy).not.toHaveBeenCalled();
    });

    it("normalizes an oversized segment KV key (>512 bytes) so L2 persistence still works", async () => {
      // Formerly warn-and-skip (the segment never reached L2 -> cold-colo miss
      // storm). toKVKey now normalizes the key, so the write lands under a
      // <=512-byte key and the read path derives the identical key.
      const store = makeStore();
      const hugeKey = "x".repeat(600); // > 512 bytes even before the version prefix
      const putSpy = vi.spyOn(kv, "put");
      const { reqCtx, reported } = ctxWithReporter();

      await runWithRequestContext(reqCtx, () =>
        store.set(hugeKey, createTestData(), 300),
      );
      await ctx.flush();

      // The write goes through under a normalized key.
      expect(putSpy).toHaveBeenCalledTimes(1);
      const kvKey = String(putSpy.mock.calls[0]![0]);
      expect(kvKey.length).toBeLessThanOrEqual(512);
      expect(kvKey.startsWith("v/v1/")).toBe(true);
      expect(kvKey).toMatch(/~[0-9a-f]{32}$/);
      // No cache-write error is reported; the entry persists to L2.
      expect(reported.filter((r) => r.category === "cache-write")).toHaveLength(
        0,
      );
      putSpy.mockRestore();
    });

    it("a TRANSIENT KV read error degrades to a miss WITHOUT evicting the still-good entry (#1)", async () => {
      // The whole point of reading KV as text + parsing manually: a 5xx/429/
      // network blip must not delete a healthy cross-colo entry (miss storm).
      const store = makeStore();
      await store.set("k", createTestData(), 300);
      await ctx.flush();
      mockCaches.clear(); // force an L1 miss so the read falls through to KV

      const getSpy = vi
        .spyOn(kv, "get")
        .mockRejectedValueOnce(new Error("KV 503 transient"));
      const delSpy = vi.spyOn(kv, "delete");
      const { reqCtx, reported } = ctxWithReporter();

      const result = hit(
        await runWithRequestContext(reqCtx, () => store.get("k")),
      );

      expect(result).toBeNull(); // degraded to a miss, no throw
      expect(reported.some((r) => r.category === "cache-read")).toBe(true);
      expect(reported.some((r) => r.category === "cache-corrupt")).toBe(false);
      expect(delSpy).not.toHaveBeenCalled(); // the good KV entry survives

      // Once the blip clears, the SAME KV entry is still readable.
      getSpy.mockRestore();
      const recovered = await runWithRequestContext(reqCtx, () =>
        store.get("k"),
      );
      expect(recovered).not.toBeNull();
    });

    it("evicts and reports a CORRUPT L1 entry as cache-corrupt (self-heal)", async () => {
      const store = makeStore();
      await store.set("k", createTestData(), 300);
      await ctx.flush();
      expect(hit(await store.get("k"))).not.toBeNull();

      // Corrupt the L1 body in place, keeping the valid HIT/stale-at headers so
      // the read reaches response.json() and fails there (partial/truncated body).
      const internal = (mockCaches._default as any).store as Map<
        string,
        { response: Response; expiresAt: number }
      >;
      const [url, entry] = [...internal.entries()][0]!;
      internal.set(url, {
        response: new Response("{ truncated json", {
          headers: entry.response.headers,
        }),
        expiresAt: entry.expiresAt,
      });
      // Isolate the L1 tier: clear KV so the corrupt-L1 read has no L2 copy to
      // fall through to and resolves to a miss. The resilient case (corrupt L1
      // but KV still serves) is covered separately.
      kv.clear();

      const delSpy = vi.spyOn(mockCaches._default, "delete");
      const { reqCtx, reported } = ctxWithReporter();
      const result = hit(
        await runWithRequestContext(reqCtx, () => store.get("k")),
      );

      expect(result).toBeNull(); // corrupt L1 -> evict -> L2 (empty) -> miss
      expect(reported.some((r) => r.category === "cache-corrupt")).toBe(true);
      expect(delSpy).toHaveBeenCalled(); // faulty L1 entry evicted
    });

    it("evicts and reports a CORRUPT KV envelope as cache-corrupt (self-heal)", async () => {
      const store = makeStore();
      // Malformed JSON directly at the segment KV key (version-prefixed), no L1.
      kv.store.set("v/v1/k", "{ not valid json");

      const delSpy = vi.spyOn(kv, "delete");
      const { reqCtx, reported } = ctxWithReporter();
      const result = hit(
        await runWithRequestContext(reqCtx, () => store.get("k")),
      );

      expect(result).toBeNull();
      expect(reported.some((r) => r.category === "cache-corrupt")).toBe(true);
      expect(delSpy).toHaveBeenCalledWith("v/v1/k"); // faulty KV entry evicted
    });

    it("reports a write error via onError and degrades to a no-op", async () => {
      const store = makeStore();
      vi.spyOn(mockCaches._default, "put").mockRejectedValue(
        new Error("cache api write failed"),
      );
      const { reqCtx, reported } = ctxWithReporter();

      // setItem must not throw even though the underlying L1 write fails.
      await runWithRequestContext(reqCtx, () =>
        store.setItem("k", "v", { ttl: 300 }),
      );
      await ctx.flush();

      expect(reported.some((r) => r.category === "cache-write")).toBe(true);
    });
  });

  // The unified read contract: an L1 problem (transient match error or a corrupt
  // body) is REPORTED (onError) and self-heals, but the read still falls through
  // to L2/KV and serves a good cross-colo copy rather than forcing a render.
  // These pin the resilient path (vs the L1-isolated "degrades to a miss" tests
  // above) and the no-false-evict fix (a corrupt-L1 evict must not race the
  // same-key promote-put that the KV fall-through schedules).
  describe("resilient L1 degradation (fall through to L2, report, no false evict)", () => {
    function ctxWithReporter() {
      const reported: Array<{ error: unknown; category: string }> = [];
      const reqCtx = makeReqCtx();
      (reqCtx as any)._reportBackgroundError = (
        error: unknown,
        category: string,
      ) => reported.push({ error, category });
      return { reqCtx, reported };
    }

    it("a transient L1 match error with a good KV copy serves from L2 (not a miss), reports cache-read, no evict", async () => {
      const store = makeStore();
      const data = createTestData();
      await store.set("k", data, 300);
      await ctx.flush(); // L1 + KV both populated

      vi.spyOn(mockCaches._default, "match").mockRejectedValueOnce(
        new Error("cache api blip"),
      );
      const delSpy = vi.spyOn(mockCaches._default, "delete");
      const { reqCtx, reported } = ctxWithReporter();
      const result = hit(
        await runWithRequestContext(reqCtx, () => store.get("k")),
      );

      expect(result).not.toBeNull(); // served from L2/KV, not a forced render
      expect(result!.data).toEqual(data);
      expect(reported.some((r) => r.category === "cache-read")).toBe(true);
      expect(reported.some((r) => r.category === "cache-corrupt")).toBe(false);
      expect(delSpy).not.toHaveBeenCalled(); // a match error never evicts
    });

    it("a corrupt L1 body with a good KV copy serves from L2 (not a miss), reports cache-corrupt, and does NOT evict (no race with the promote)", async () => {
      const store = makeStore();
      const data = createTestData();
      await store.set("k", data, 300);
      await ctx.flush();
      expect(hit(await store.get("k"))).not.toBeNull();

      // Corrupt the L1 body in place, keeping valid headers so the read reaches
      // response.json() and fails there.
      const internal = (mockCaches._default as any).store as Map<
        string,
        { response: Response; expiresAt: number }
      >;
      const [url, entry] = [...internal.entries()][0]!;
      internal.set(url, {
        response: new Response("{ truncated json", {
          headers: entry.response.headers,
        }),
        expiresAt: entry.expiresAt,
      });

      const delSpy = vi.spyOn(mockCaches._default, "delete");
      const { reqCtx, reported } = ctxWithReporter();
      const result = hit(
        await runWithRequestContext(reqCtx, () => store.get("k")),
      );

      expect(result).not.toBeNull(); // good KV copy served, not a forced render
      expect(result!.data).toEqual(data);
      expect(reported.some((r) => r.category === "cache-corrupt")).toBe(true);
      // The fix: KV had a copy to promote, so the corrupt L1 entry is NOT eagerly
      // deleted -- that delete would race the same-key promote-put.
      expect(delSpy).not.toHaveBeenCalled();

      // The heal-by-overwrite must actually LAND: flush the promote, clear KV,
      // and re-read. Serving now (KV empty) proves the KV->L1 promote overwrote
      // the poison entry -- the property that makes skipping the eager evict safe.
      await ctx.flush();
      kv.clear();
      const reread = hit(
        await runWithRequestContext(reqCtx, () => store.get("k")),
      );
      expect(reread).not.toBeNull();
      expect(reread!.data).toEqual(data);
    });

    it("a corrupt L1 function body with a good KV copy serves from L2, reports cache-corrupt, no evict (getItem)", async () => {
      const store = makeStore();
      await store.setItem("k", "kv-value", { ttl: 300 });
      await ctx.flush();
      expect(await store.getItem("k")).not.toBeNull();

      const internal = (mockCaches._default as any).store as Map<
        string,
        { response: Response; expiresAt: number }
      >;
      const [url, entry] = [...internal.entries()][0]!;
      internal.set(url, {
        response: new Response("{ truncated", {
          headers: entry.response.headers,
        }),
        expiresAt: entry.expiresAt,
      });

      const delSpy = vi.spyOn(mockCaches._default, "delete");
      const { reqCtx, reported } = ctxWithReporter();
      const result = await runWithRequestContext(reqCtx, () =>
        store.getItem("k"),
      );

      expect(result).not.toBeNull();
      expect(result!.value).toBe("kv-value");
      expect(reported.some((r) => r.category === "cache-corrupt")).toBe(true);
      expect(delSpy).not.toHaveBeenCalled();

      // The KV->L1 promote must land: clear KV and re-read; serving from the
      // promoted (overwritten) L1 entry is what makes skipping the evict safe.
      await ctx.flush();
      kv.clear();
      const reread = await runWithRequestContext(reqCtx, () =>
        store.getItem("k"),
      );
      expect(reread).not.toBeNull();
      expect(reread!.value).toBe("kv-value");
    });

    it("a transient L1 match error on the document path reports cache-read and degrades (no throw)", async () => {
      const store = makeStore();
      await store.putResponse!(
        "k",
        new Response("doc-body", {
          headers: { "Content-Type": "text/html" },
        }),
        300,
      );
      await ctx.flush();
      // Isolate: clear KV so the degraded document read resolves to a clean miss.
      kv.clear();

      vi.spyOn(mockCaches._default, "match").mockRejectedValueOnce(
        new Error("cache api blip"),
      );
      const delSpy = vi.spyOn(mockCaches._default, "delete");
      const { reqCtx, reported } = ctxWithReporter();
      const result = await runWithRequestContext(reqCtx, () =>
        store.getResponse!("k"),
      );

      expect(result).toBeNull(); // L1 error -> L2 (empty) -> miss, no throw
      expect(reported.some((r) => r.category === "cache-read")).toBe(true);
      expect(delSpy).not.toHaveBeenCalled();
    });

    it("a tag-marker KV read that exceeds the budget fails OPEN (entry served, not treated as invalidated)", async () => {
      const store = makeStore();
      await store.set("k", createTestData(["t"]), 300);
      await ctx.flush(); // fresh, tagged entry in L1 (+ KV)

      // The entry read is an L1 hit, so the only KV read is the tag marker.
      // Make that marker read hang so the kvReadTimeoutMs budget fires.
      vi.spyOn(kv, "get").mockImplementation((key: string) =>
        // Key on the exported prefix constant, not a "__tag__" literal, so a
        // prefix rename keeps hanging the marker read (and exercising the
        // timeout) instead of silently passing this test vacuously.
        key.includes(TAG_MARKER_PREFIX)
          ? new Promise<string>(() => {})
          : Promise.resolve(null),
      );
      const delSpy = vi.spyOn(mockCaches._default, "delete");
      const kvDelSpy = vi.spyOn(kv, "delete");

      const { reqCtx } = ctxWithReporter();
      const resultPromise = runWithRequestContext(reqCtx, () => store.get("k"));
      // Advance past the KV budget so the marker read times out and fails open.
      await vi.advanceTimersByTimeAsync(KV_READ_TIMEOUT_MS);
      const result = hit(await resultPromise);

      // Fail-open: a marker read that cannot complete must not turn a good hit
      // into a wrongful invalidation. Not vacuous: the SAME tagged entry (with
      // its tag) is served, and the fail-open evicts neither L1 nor KV.
      expect(result).not.toBeNull();
      expect(result!.data.tags).toEqual(["t"]);
      expect(delSpy).not.toHaveBeenCalled();
      expect(kvDelSpy).not.toHaveBeenCalled();
    });
  });

  describe("reserved tag-marker namespace guard", () => {
    function ctxWithReporter() {
      const reported: Array<{ error: unknown; category: string }> = [];
      const reqCtx = makeReqCtx();
      (reqCtx as any)._reportBackgroundError = (
        error: unknown,
        category: string,
      ) => reported.push({ error, category });
      return { reqCtx, reported };
    }

    it("a segment key colliding with __tag__/ is rejected (no write, no marker clobber) and reported", async () => {
      const store = makeStore();
      // Establish a live marker for tag "x" via a real invalidation.
      await runWithRequestContext(makeReqCtx(), () =>
        store.invalidateTags(["x"]),
      );
      await ctx.flush();
      const markerBefore = kv.store.get("v/v1/__tag__/x");
      expect(markerBefore).toBeDefined();

      // A misconfigured keyGenerator returning "__tag__/x" must NOT overwrite
      // the marker; the write is a reported no-op.
      const { reqCtx, reported } = ctxWithReporter();
      await runWithRequestContext(reqCtx, () =>
        store.set("__tag__/x", createTestData(), 300),
      );
      await ctx.flush();

      expect(kv.store.get("v/v1/__tag__/x")).toBe(markerBefore); // untouched
      expect(reported.some((r) => r.category === "cache-write")).toBe(true);
    });

    it("a reserved-key get/delete is a reported miss/no-op and never evicts the marker", async () => {
      const store = makeStore();
      await runWithRequestContext(makeReqCtx(), () =>
        store.invalidateTags(["x"]),
      );
      await ctx.flush();
      expect(kv.store.get("v/v1/__tag__/x")).toBeDefined();

      const delSpy = vi.spyOn(kv, "delete");
      const { reqCtx, reported } = ctxWithReporter();

      const got = await runWithRequestContext(reqCtx, () =>
        store.get("__tag__/x"),
      );
      const deleted = await runWithRequestContext(reqCtx, () =>
        store.delete("__tag__/x"),
      );

      expect(got).toBeNull();
      expect(deleted).toBe(false);
      expect(delSpy).not.toHaveBeenCalledWith("v/v1/__tag__/x"); // marker safe
      expect(kv.store.get("v/v1/__tag__/x")).toBeDefined();
      expect(reported.some((r) => r.category === "cache-read")).toBe(true);
      expect(reported.some((r) => r.category === "cache-delete")).toBe(true);
    });

    it("also guards the __tagmarker__/ L1-marker namespace (set/get/delete are reported no-ops/misses, marker untouched)", async () => {
      // The L1 marker lives in the Cache API under a __tagmarker__/<tag> request
      // URL, a DIFFERENT prefix from the KV __tag__/ key - a colliding segment
      // key would slip past a __tag__/-only guard. The guard returns before any
      // Cache API call, so the marker request URL is never written or deleted.
      const store = makeStore({ tagCacheTtl: 60 });
      const putSpy = vi.spyOn(mockCaches._default, "put");
      const delSpy = vi.spyOn(mockCaches._default, "delete");
      const { reqCtx, reported } = ctxWithReporter();

      await runWithRequestContext(reqCtx, () =>
        store.set("__tagmarker__/x", createTestData(), 300),
      );
      const got = await runWithRequestContext(reqCtx, () =>
        store.get("__tagmarker__/x"),
      );
      const deleted = await runWithRequestContext(reqCtx, () =>
        store.delete("__tagmarker__/x"),
      );
      await ctx.flush();

      const touchedMarker = (calls: unknown[][]) =>
        calls.some(([req]) =>
          decodeURIComponent((req as Request).url).includes("__tagmarker__/x"),
        );

      expect(got).toBeNull();
      expect(deleted).toBe(false);
      // marker namespace never written or evicted by the segment ops
      expect(touchedMarker(putSpy.mock.calls)).toBe(false);
      expect(touchedMarker(delSpy.mock.calls)).toBe(false);
      expect(reported.some((r) => r.category === "cache-write")).toBe(true);
      expect(reported.some((r) => r.category === "cache-read")).toBe(true);
      expect(reported.some((r) => r.category === "cache-delete")).toBe(true);
    });
  });

  // Reconcile hardening (review follow-ups). Each `it` pins a specific fix from
  // the post-merge adversarial review; the bug-fix cases are red without the fix
  // and green with it (see the PR description's red-before-green note).
  describe("reconcile hardening (review follow-ups)", () => {
    function ctxWithReporter() {
      const reported: Array<{ error: unknown; category: string }> = [];
      const reqCtx = makeReqCtx();
      (reqCtx as any)._reportBackgroundError = (
        error: unknown,
        category: string,
      ) => reported.push({ error, category });
      return { reqCtx, reported };
    }

    // F1: a marker read that is in flight when a concurrent updateTag() writes
    // the memo must not clobber that write when it resolves (read-your-own-writes
    // for the rest of the request).
    it("an in-flight marker read does not clobber a concurrent invalidate's memo write (RYW)", async () => {
      const store = makeStore(); // tagCacheTtl=0 -> straight to KV marker read
      await store.setItem("k", "v", { ttl: 300, tags: ["catalog"] });
      await ctx.flush();

      let releaseMarker!: (v: string | null) => void;
      let markerGetStarted!: () => void;
      const started = new Promise<void>((res) => (markerGetStarted = res));
      const gate = new Promise<string | null>((res) => (releaseMarker = res));
      vi.spyOn(kv, "get").mockImplementation((key: string, opts?: any) => {
        if (String(key).includes("__tag__/catalog")) {
          markerGetStarted();
          return gate as any;
        }
        const raw = kv.store.get(key);
        if (raw === undefined) return Promise.resolve(null);
        return Promise.resolve(opts?.type === "json" ? JSON.parse(raw) : raw);
      });

      const { reqCtx } = ctxWithReporter();
      await runWithRequestContext(reqCtx, async () => {
        const inflightRead = store.getItem("k"); // parks on the gated marker read
        await started; // guarantee the read passed memo.has -> reached KV
        vi.advanceTimersByTime(10);
        await store.invalidateTags(["catalog"]); // memo[catalog]=invalidatedAt
        releaseMarker(null); // resolve with the PRE-invalidation value
        await inflightRead; // must NOT overwrite the memo back to null
        // The subsequent read must still see the invalidation.
        expect(await store.getItem("k")).toBeNull();
      });
    });

    // F2: a KV body that parses to a primitive ('null') must be treated as
    // corruption (evicted), not sent to the outer catch as a transient cache-read
    // by a validator that throws dereferencing null.
    it("treats a KV body that parses to a primitive ('null') as corrupt (evicts), not a transient read error", async () => {
      const store = makeStore();
      kv.store.set("v/v1/k", "null"); // parses fine; validate(null) would throw

      const delSpy = vi.spyOn(kv, "delete");
      const { reqCtx, reported } = ctxWithReporter();
      const result = hit(
        await runWithRequestContext(reqCtx, () => store.get("k")),
      );
      await ctx.flush(); // eviction is now background (F6)

      expect(result).toBeNull();
      expect(reported.some((r) => r.category === "cache-corrupt")).toBe(true);
      expect(reported.some((r) => r.category === "cache-read")).toBe(false);
      expect(delSpy).toHaveBeenCalledWith("v/v1/k");
    });

    // F6: the corrupt-entry KV eviction must be scheduled in the background
    // (waitUntil), never AWAITED on the read path (an unbounded kv.delete would
    // re-introduce exactly the stall the read budgets prevent). Pinned with a
    // deferred delete: get() must resolve while the delete is still pending.
    // With the old awaited evict, the get() await below would never resolve
    // (the test would time out) -- hence the tight per-test timeout.
    it(
      "evicts a corrupt KV entry in the BACKGROUND, not awaited on the read path",
      { timeout: 2000 },
      async () => {
        const store = makeStore();
        kv.store.set("v/v1/k", "{ not valid json");

        let deleteResolved = false;
        let releaseDelete!: () => void;
        const deleteGate = new Promise<void>((res) => {
          releaseDelete = () => {
            deleteResolved = true;
            res();
          };
        });
        const delSpy = vi
          .spyOn(kv, "delete")
          .mockReturnValue(deleteGate as Promise<void>);

        const result = await runWithRequestContext(makeReqCtx(), () =>
          store.get("k"),
        );
        // get() returned while the (still-pending) delete has not resolved: it was
        // scheduled, not awaited. An awaited evict would have parked get() here.
        expect(result).toBeNull();
        expect(delSpy).toHaveBeenCalledWith("v/v1/k");
        expect(deleteResolved).toBe(false);

        releaseDelete();
        await ctx.flush();
      },
    );

    // F7: two stores in one request with different KV bindings (and versions)
    // must not cross-pollute the per-request marker memo.
    it("two stores in one request do not cross-pollute the tag-marker memo", async () => {
      const kvA = new MockKV();
      const kvB = new MockKV();
      const storeA = new CFCacheStore({
        ctx: ctx as any,
        kv: kvA as any,
        baseUrl: "https://test.internal/",
        version: "vA",
      });
      const storeB = new CFCacheStore({
        ctx: ctx as any,
        kv: kvB as any,
        baseUrl: "https://test.internal/",
        version: "vB",
      });

      // A: tag then invalidate -> A's entry is invalidated (marker only in kvA).
      await storeA.set("k", createTestData(["t"]), 300);
      await ctx.flush();
      vi.advanceTimersByTime(10);
      await storeA.invalidateTags(["t"]); // outside a request ctx: no memo write

      // B: a fresh entry tagged "t" with NO marker in kvB -> a valid hit.
      await storeB.set("k", createTestData(["t"]), 300);
      await ctx.flush();

      await runWithRequestContext(makeReqCtx(), async () => {
        // B reads first and (in the buggy shared-memo) memoizes "t" -> null.
        expect(await storeB.get("k")).not.toBeNull();
        // A must consult kvA's marker (invalidated), NOT B's memoized null.
        expect(await storeA.get("k")).toBeNull();
      });
    });

    // F9: a transient L1 tag-marker match error must be reported as cache-read
    // (like the data read paths), not silently discarded at the destructuring.
    it("reports a transient L1 tag-marker match error as cache-read (still serves via KV)", async () => {
      const store = makeStore({ tagCacheTtl: 60 });
      await store.set("k", createTestData(["shared"]), 300);
      await ctx.flush();

      const realMatch = mockCaches._default.match.bind(mockCaches._default);
      vi.spyOn(mockCaches._default, "match").mockImplementation(
        async (req: Request) => {
          if (decodeURIComponent(req.url).includes("__tagmarker__/shared")) {
            throw new Error("marker match blip");
          }
          return realMatch(req);
        },
      );

      const { reqCtx, reported } = ctxWithReporter();
      const result = hit(
        await runWithRequestContext(reqCtx, () => store.get("k")),
      );

      // Served (marker match error falls through to the KV marker, which is
      // absent -> not invalidated), and the match error reached onError.
      expect(result).not.toBeNull();
      expect(reported.some((r) => r.category === "cache-read")).toBe(true);
    });

    // F10: a non-array tags value (direct store misuse) must be cached untagged
    // and never throw `.map` on the read path (mis-reported as cache-read).
    it("a non-array tags value is cached untagged and never throws on read", async () => {
      const store = makeStore();
      const { reqCtx, reported } = ctxWithReporter();
      await runWithRequestContext(reqCtx, () =>
        store.setItem("k", "v", { ttl: 300, tags: "products" as any }),
      );
      await ctx.flush();

      const result = await runWithRequestContext(reqCtx, () =>
        store.getItem("k"),
      );
      expect(result).not.toBeNull();
      expect(result!.value).toBe("v");
      expect(reported.some((r) => r.category === "cache-read")).toBe(false);
    });

    describe("tag TTL option sanitization (F5)", () => {
      it("raises a tagInvalidationTtl below KV's 60s floor (invalidation still works, warns once)", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const store = makeStore({
          namespace: "ttl-floor-fixture",
          tagInvalidationTtl: 30,
        });
        const putSpy = vi.spyOn(kv, "put");

        await store.invalidateTags(["t"]);

        const markerPut = putSpy.mock.calls.find(([key]) =>
          String(key).includes("__tag__/t"),
        );
        expect(markerPut).toBeDefined();
        // Floored to 60 so CF KV does not reject the write (which would make
        // EVERY invalidation throw); raw 30 would have been passed unchanged.
        expect(
          (markerPut![2] as { expirationTtl?: number } | undefined)
            ?.expirationTtl,
        ).toBe(60);
        expect(warn).toHaveBeenCalledWith(
          expect.stringContaining("below Cloudflare KV"),
        );
        putSpy.mockRestore();
        warn.mockRestore();
      });

      it("warns exactly once per namespace when invalidating with no tagInvalidationTtl (unbounded KV markers)", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        // Unique namespace: the warning de-dupes once per namespace at the
        // module level, so reusing "default" would consume that slot for the
        // rest of the process and couple this test to others' ordering.
        const store = makeStore({ namespace: "no-ttl-warn-fixture" });

        // Two distinct tags in one batch, plus a second batch: still ONE warning.
        await store.invalidateTags(["alpha", "beta"]);
        await store.invalidateTags(["gamma"]);

        const noExpiryWarns = warn.mock.calls.filter(([msg]) =>
          String(msg).includes("tagInvalidationTtl is unset"),
        );
        expect(noExpiryWarns).toHaveLength(1);
        expect(noExpiryWarns[0]![0]).toEqual(
          expect.stringContaining("tagInvalidationTtl"),
        );
        warn.mockRestore();
      });

      it("does NOT emit the no-expiry warning when tagInvalidationTtl is set", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const store = makeStore({
          namespace: "ttl-set-fixture",
          tagInvalidationTtl: 300,
        });

        await store.invalidateTags(["alpha", "beta"]);

        const noExpiryWarns = warn.mock.calls.filter(([msg]) =>
          String(msg).includes("tagInvalidationTtl is unset"),
        );
        expect(noExpiryWarns).toHaveLength(0);
        warn.mockRestore();
      });

      it("treats a non-finite tagCacheTtl (Infinity) as disabled, not 'max-age=Infinity'", async () => {
        const store = makeStore({ tagCacheTtl: Infinity });
        await store.set("k", createTestData(["shared"]), 300);
        await ctx.flush();

        const putSpy = vi.spyOn(mockCaches._default, "put");
        await runWithRequestContext(makeReqCtx(), () => store.get("k"));
        await ctx.flush();

        // Disabled (sanitized to 0): no L1 marker entry written, so no invalid
        // Cache-Control: max-age=Infinity. Infinity>0 would have enabled it.
        const markerPut = putSpy.mock.calls.find(([req]) =>
          decodeURIComponent((req as Request).url).includes(
            "__tagmarker__/shared",
          ),
        );
        expect(markerPut).toBeUndefined();
        putSpy.mockRestore();
      });
    });

    describe("L1 marker write-through failure (F3)", () => {
      it("surfaces a failed L1 marker write-through on invalidate (reports + evicts the stale marker)", async () => {
        const store = makeStore({ tagCacheTtl: 60 });
        // Prime the colo L1 with the ABSENT sentinel for "shared".
        await store.set("k", createTestData(["shared"]), 300);
        await ctx.flush();
        await runWithRequestContext(makeReqCtx(), () => store.get("k"));
        await ctx.flush();

        // Fail the L1 marker write-through; allow its compensating delete.
        const putSpy = vi
          .spyOn(mockCaches._default, "put")
          .mockImplementation(async (req: Request) => {
            if (decodeURIComponent(req.url).includes("__tagmarker__/shared")) {
              throw new Error("L1 marker put failed");
            }
          });
        const delSpy = vi.spyOn(mockCaches._default, "delete");
        const { reqCtx, reported } = ctxWithReporter();

        vi.advanceTimersByTime(10);
        await runWithRequestContext(reqCtx, () =>
          store.invalidateTags(["shared"]),
        );

        // The swallowed failure is now surfaced (cache-invalidate), and the
        // stale L1 marker is evicted so the next read re-reads the fresh KV
        // marker instead of serving the stale ABSENT sentinel for tagCacheTtl.
        expect(reported.some((r) => r.category === "cache-invalidate")).toBe(
          true,
        );
        const markerDelete = delSpy.mock.calls.find(([req]) =>
          decodeURIComponent((req as Request).url).includes(
            "__tagmarker__/shared",
          ),
        );
        expect(markerDelete).toBeDefined();
        putSpy.mockRestore();
        delSpy.mockRestore();
      });
    });

    describe("stale tagged entries: REVALIDATING x tags (F11)", () => {
      it("keeps tags across the REVALIDATING re-put so a stale entry stays invalidatable", async () => {
        const store = makeStore();
        // ttl=1s, swr=60s: goes stale fast but stays in L1 across the SWR window.
        await store.set("k", createTestData(["products"]), 1, 60);
        await ctx.flush();

        // Go stale, then read once -> marks REVALIDATING (re-put must carry tags).
        vi.advanceTimersByTime(1500);
        const stale = hit(await store.get("k"));
        expect(stale).not.toBeNull();
        expect(stale!.shouldRevalidate).toBe(true);
        await ctx.flush(); // markRevalidating re-put lands

        // Invalidate the tag; the REVALIDATING entry's tag check must run first
        // and treat it as a miss (its tags survived the re-put).
        vi.advanceTimersByTime(10);
        await store.invalidateTags(["products"]);
        expect(hit(await store.get("k"))).toBeNull();
      });
    });

    describe("KV->L1 promotion preserves tags (F13)", () => {
      it("segment tier: a promoted segment stays invalidatable", async () => {
        const store = makeStore();
        await store.set("k", createTestData(["products"]), 300);
        await ctx.flush();
        mockCaches.clear(); // L1 gone, KV holds it

        expect(hit(await store.get("k"))).not.toBeNull(); // KV serve + promote
        await ctx.flush();

        vi.advanceTimersByTime(10);
        await store.invalidateTags(["products"]);
        // The promoted L1 entry must still carry tags (L1 hit, KV not consulted).
        expect(hit(await store.get("k"))).toBeNull();
      });

      it("document tier: a promoted response stays invalidatable", async () => {
        const store = makeStore();
        await store.putResponse!(
          "k",
          new Response("body", { status: 200 }),
          300,
          0,
          ["page"],
        );
        await ctx.flush();
        mockCaches.clear();

        expect(await store.getResponse!("k")).not.toBeNull(); // KV serve + promote
        await ctx.flush();

        vi.advanceTimersByTime(10);
        await store.invalidateTags(["page"]);
        expect(await store.getResponse!("k")).toBeNull();
      });
    });

    describe("debug observability (markerMs, match-error)", () => {
      it("emits markerMs on a tagged read so the marker-resolution tail is visible", async () => {
        const events: Array<Record<string, unknown>> = [];
        const store = makeStore({
          debug: (e: Record<string, unknown>) => events.push(e),
        });
        await store.set("k", createTestData(["shared"]), 300);
        await ctx.flush();

        await runWithRequestContext(makeReqCtx(), () => store.get("k"));

        // The l1-fresh event for a TAGGED entry carries a measured markerMs (the
        // serial memo->L1->KV marker read that was previously invisible).
        const fresh = events.find((e) => e.outcome === "l1-fresh");
        expect(fresh).toBeDefined();
        expect(typeof fresh!.markerMs).toBe("number");
      });

      it("emits a match-error outcome when the L1 match rejects (distinct from l1-miss)", async () => {
        const events: Array<Record<string, unknown>> = [];
        const store = makeStore({
          debug: (e: Record<string, unknown>) => events.push(e),
        });
        await store.set("k", createTestData(), 300);
        await ctx.flush();
        kv.clear(); // no L2 fallback -> a clean miss after the match error

        vi.spyOn(mockCaches._default, "match").mockRejectedValueOnce(
          new Error("match blip"),
        );
        await runWithRequestContext(makeReqCtx(), () => store.get("k"));

        // A match rejection is reported as match-error in debug, agreeing with
        // the cache-read routed to onError -- not masquerading as l1-miss.
        expect(events.some((e) => e.outcome === "match-error")).toBe(true);
        expect(events.some((e) => e.outcome === "l1-miss")).toBe(false);
      });
    });

    // F13c: the resilient document path (L1 match error WITH a good KV copy)
    // must serve from L2 rather than forcing a render.
    it("a document-path L1 match error with a good KV copy serves from L2 (not a miss)", async () => {
      const store = makeStore();
      await store.putResponse!(
        "k",
        new Response("doc-body", { headers: { "Content-Type": "text/html" } }),
        300,
      );
      await ctx.flush(); // L1 + KV both populated

      vi.spyOn(mockCaches._default, "match").mockRejectedValueOnce(
        new Error("cache api blip"),
      );
      const delSpy = vi.spyOn(mockCaches._default, "delete");
      const { reqCtx, reported } = ctxWithReporter();
      const result = await runWithRequestContext(reqCtx, () =>
        store.getResponse!("k"),
      );

      expect(result).not.toBeNull(); // served from KV, not a forced render
      expect(await result!.response.text()).toBe("doc-body");
      expect(reported.some((r) => r.category === "cache-read")).toBe(true);
      expect(delSpy).not.toHaveBeenCalled();
    });
  });

  describe("corrupt taggedAt header (NaN fail-open)", () => {
    // Intercept L1 reads so the matched entry's tagged-at header is rewritten to
    // a non-numeric value, simulating a corrupt/tampered CACHE_TAGGED_AT_HEADER.
    // Number("garbage") -> NaN; readTagInfo previously returned that NaN verbatim.
    function corruptTaggedAtOnRead(): void {
      const real = mockCaches._default.match.bind(mockCaches._default);
      vi.spyOn(mockCaches._default, "match").mockImplementation(async (req) => {
        const res = await real(req);
        if (!res) return res;
        if (!res.headers.get("x-edge-cache-tagged-at")) return res;
        const headers = new Headers(res.headers);
        headers.set("x-edge-cache-tagged-at", "not-a-number");
        return new Response(res.body, {
          status: res.status,
          statusText: res.statusText,
          headers,
        });
      });
    }

    it("treats an item with a NaN taggedAt as untagged (not a permanent un-invalidatable hit)", async () => {
      const store = makeStore();
      await store.setItem("k", "v", { ttl: 300, tags: ["catalog"] });
      await ctx.flush();

      corruptTaggedAtOnRead();

      // The fix makes readTagInfo treat a non-finite taggedAt like the missing-
      // tags case, so the read surfaces NO live tags. Before the fix it returned
      // { tags: ["catalog"], taggedAt: NaN } - a tag set that isGloballyInvalidated
      // could never act on (marker >= NaN is always false), so the entry was
      // permanently non-invalidatable while still claiming to be tagged.
      const hit = await store.getItem("k");
      expect(hit).not.toBeNull();
      expect(hit!.tags).toBeUndefined();
    });

    it("does not short-circuit isGloballyInvalidated into a permanent valid hit", async () => {
      const store = makeStore();
      await store.setItem("k", "v", { ttl: 300, tags: ["catalog"] });
      await ctx.flush();

      // Invalidate the tag FIRST, so a correctly-read entry would already be a
      // miss. With the corrupt NaN taggedAt, the old code's `!taggedAt` guard
      // fired ("not invalidated") and served the entry regardless of the marker.
      vi.advanceTimersByTime(10);
      await store.invalidateTags(["catalog"]);

      corruptTaggedAtOnRead();

      // Fixed behavior: the entry is treated as untagged, so it carries no tag
      // claim that could be (mis)reported as live + un-invalidatable.
      const hit = await store.getItem("k");
      expect(hit?.tags).toBeUndefined();
    });
  });
});
