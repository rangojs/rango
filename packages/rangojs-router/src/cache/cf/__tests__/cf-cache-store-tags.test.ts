import { describe, it, expect, beforeEach, vi } from "vitest";
import { CFCacheStore } from "../cf-cache-store";
import type { CachedEntryData } from "../../types";
import {
  createRequestContext,
  runWithRequestContext,
} from "../../../server/request-context";

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
  async put(key: string, value: string): Promise<void> {
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
  handles: {},
  expiresAt: Date.now() + 60_000,
  tags,
});

describe("CFCacheStore tag invalidation (single-store)", () => {
  let ctx: ReturnType<typeof createMockCtx>;
  let kv: MockKV;

  beforeEach(() => {
    mockCaches.clear();
    kv = new MockKV();
    ctx = createMockCtx();
    vi.useFakeTimers();
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

      expect(await store.get("k")).not.toBeNull();

      vi.advanceTimersByTime(10);
      await store.invalidateTags(["products"]);

      expect(await store.get("k")).toBeNull();
    });

    it("leaves untagged segments untouched", async () => {
      const store = makeStore();
      await store.set("k", createTestData(), 300);
      await ctx.flush();

      await store.invalidateTags(["products"]);
      expect(await store.get("k")).not.toBeNull();
    });

    it("does not invalidate an entry tagged AFTER the invalidation", async () => {
      const store = makeStore();
      await store.invalidateTags(["products"]);

      vi.advanceTimersByTime(10);
      await store.set("k", createTestData(["products"]), 300);
      await ctx.flush();

      // taggedAt is now newer than the invalidation marker -> still a hit.
      expect(await store.get("k")).not.toBeNull();
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
        await store.get("k1");
        await store.get("k2");
        await store.get("k1");
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
        expect(await store.get("k")).not.toBeNull();
      });
      await ctx.flush();

      // Invalidate: write-through must overwrite the cached absent sentinel.
      vi.advanceTimersByTime(10);
      await store.invalidateTags(["shared"]);

      // A later request in the SAME colo, still within the 60s window, must see
      // the invalidation (a delete-then-rely-on-KV approach would serve stale).
      await runWithRequestContext(makeReqCtx(), async () => {
        expect(await store.get("k")).toBeNull();
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

      expect(await store.get("k")).not.toBeNull();

      vi.advanceTimersByTime(10);
      await store.invalidateTags(["商品"]);
      expect(await store.get("k")).toBeNull();
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

    it("rejects (without calling KV) when a tag exceeds the 512-byte KV key limit", async () => {
      const store = makeStore();
      const hugeTag = "x".repeat(600);
      const putSpy = vi.spyOn(kv, "put");

      const err = await store.invalidateTags([hugeTag]).catch((e) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error & { cause?: Error }).cause?.message).toMatch(
        /over the 512-byte limit/,
      );
      // An over-limit key is rejected up front; KV is never even called for it.
      const markerPuts = putSpy.mock.calls.filter(([key]) =>
        String(key).includes("__tag__/"),
      );
      expect(markerPuts.length).toBe(0);
      putSpy.mockRestore();
    });
  });

  describe("cross-tag isolation", () => {
    it("invalidating one tag leaves an entry under a DIFFERENT tag intact", async () => {
      const store = makeStore();
      await store.set("ka", createTestData(["tag-a"]), 300);
      await store.set("kb", createTestData(["tag-b"]), 300);
      await ctx.flush();

      expect(await store.get("ka")).not.toBeNull();
      expect(await store.get("kb")).not.toBeNull();

      vi.advanceTimersByTime(10);
      await store.invalidateTags(["tag-a"]);

      // The marker is per-tag: only tag-a's entry is a miss; tag-b survives. A
      // regression that consulted a broader marker tier would over-invalidate kb.
      expect(await store.get("ka")).toBeNull();
      expect(await store.get("kb")).not.toBeNull();
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

    it("reports a read infra error via onError and degrades to a miss (does not throw)", async () => {
      const store = makeStore();
      await store.set("k", createTestData(), 300);
      await ctx.flush();

      vi.spyOn(mockCaches._default, "match").mockRejectedValueOnce(
        new Error("cache api unavailable"),
      );
      const delSpy = vi.spyOn(mockCaches._default, "delete");
      const { reqCtx, reported } = ctxWithReporter();
      const result = await runWithRequestContext(reqCtx, () => store.get("k"));

      expect(result).toBeNull(); // degraded to a miss, no throw
      expect(reported.some((r) => r.category === "cache-read")).toBe(true);
      // A transient L1 error must NOT be mistaken for corruption: the entry is
      // left intact (no eviction), unlike the cache-corrupt self-heal path.
      expect(reported.some((r) => r.category === "cache-corrupt")).toBe(false);
      expect(delSpy).not.toHaveBeenCalled();
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

      const result = await runWithRequestContext(reqCtx, () => store.get("k"));

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
      expect(await store.get("k")).not.toBeNull();

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

      const delSpy = vi.spyOn(mockCaches._default, "delete");
      const { reqCtx, reported } = ctxWithReporter();
      const result = await runWithRequestContext(reqCtx, () => store.get("k"));

      expect(result).toBeNull(); // degrade
      expect(reported.some((r) => r.category === "cache-corrupt")).toBe(true);
      expect(delSpy).toHaveBeenCalled(); // faulty L1 entry evicted
    });

    it("evicts and reports a CORRUPT KV envelope as cache-corrupt (self-heal)", async () => {
      const store = makeStore();
      // Malformed JSON directly at the segment KV key (version-prefixed), no L1.
      kv.store.set("v/v1/k", "{ not valid json");

      const delSpy = vi.spyOn(kv, "delete");
      const { reqCtx, reported } = ctxWithReporter();
      const result = await runWithRequestContext(reqCtx, () => store.get("k"));

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
});
