import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { CFCacheStore, TAG_MARKER_PREFIX } from "../cf-cache-store.js";
import type { CachedEntryData } from "../../types.js";
import {
  createRequestContext,
  runWithRequestContext,
} from "../../../server/request-context.js";

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
// Same mocks as cf-cache-store-tags.test.ts: MockCache honors Cache-Control
// max-age against the fake clock; MockKV is a plain map; the mock ctx collects
// waitUntil promises behind an explicit flush().

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
}

const mockCaches = new MockCaches();
(globalThis as any).caches = mockCaches;

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

describe("CFCacheStore purge mode (tagPurge)", () => {
  let ctx: ReturnType<typeof createMockCtx>;
  let kv: MockKV;

  beforeEach(() => {
    vi.restoreAllMocks();
    mockCaches.clear();
    kv = new MockKV();
    ctx = createMockCtx();
    vi.useFakeTimers();
  });

  afterEach(() => {
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

  describe("entry Cache-Tag headers", () => {
    it("stamps the namespaced entry tiers on a tagged segment (purge mode off too)", async () => {
      const put = vi.spyOn(mockCaches._default, "put");
      const store = makeStore();
      await store.set("k", createTestData(["products"]), 300);
      await ctx.flush();

      const dataPut = put.mock.calls.find(([req]) =>
        (req as Request).url.endsWith("/v/v1/k"),
      );
      expect(dataPut).toBeDefined();
      expect((dataPut![1] as Response).headers.get("Cache-Tag")).toBe(
        "rg:default,rg:default:e,rg:default:e:products",
      );
    });

    it("uses the store namespace and encodes unsafe tag characters", async () => {
      const put = vi.spyOn(mockCaches._default, "put");
      const store = makeStore({ namespace: "shop" });
      await store.setItem("item", "value", { tags: ["a,b c"] });
      await ctx.flush();

      const dataPut = put.mock.calls.find(([req]) =>
        (req as Request).url.includes("fn%3Aitem"),
      );
      expect(dataPut).toBeDefined();
      expect((dataPut![1] as Response).headers.get("Cache-Tag")).toBe(
        "rg:shop,rg:shop:e,rg:shop:e:a%2Cb%20c",
      );
    });

    it("encodes a comma-bearing namespace so tokens cannot split (leak + purge-miss regression)", async () => {
      // A raw "a,b" namespace would split into bogus tokens inside the
      // comma-delimited header: stripInternalCacheTags would then keep (leak)
      // them, and the purged tag string would never match a stored token.
      const tagPurge = vi.fn(async (_tags: string[]) => {});
      const store = makeStore({ namespace: "a,b", tagPurge });

      await store.putResponse("doc", new Response("<html/>"), 300, 0, [
        "products",
      ]);
      await ctx.flush();

      const hit = await store.getResponse("doc");
      expect(hit).not.toBeNull();
      // All internal tokens stripped on serve — nothing leaks.
      expect(hit!.response.headers.get("Cache-Tag")).toBeNull();

      await store.invalidateTags(["products"]);
      // The purged tag matches the stored (encoded) token.
      expect(tagPurge).toHaveBeenCalledWith(["rg:a%2Cb:e:products"]);
    });

    it("collapses an over-long tag to a hashed token, consistently on write and purge", async () => {
      const longTag = "a".repeat(300); // encoded token would exceed the 256-char bound
      const tagPurge = vi.fn(async (_tags: string[]) => {});
      const put = vi.spyOn(mockCaches._default, "put");
      const store = makeStore({ tagPurge });

      await store.set("k", createTestData([longTag]), 300);
      await ctx.flush();

      const dataPut = put.mock.calls.find(([req]) =>
        (req as Request).url.endsWith("/v/v1/k"),
      );
      const header = (dataPut![1] as Response).headers.get("Cache-Tag")!;
      const match =
        /^rg:default,rg:default:e,(rg:default:e:h:[0-9a-f]{16})$/.exec(header);
      expect(match).not.toBeNull();

      await store.invalidateTags([longTag]);
      // The purged token is the SAME hashed token the entry was stored with.
      expect(tagPurge).toHaveBeenCalledWith([match![1]]);
    });

    it("omits an over-limit aggregate Cache-Tag header; purge mode then falls back to the marker check", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      // 100 tags x ~200 chars: each token stays under the per-token bound, but
      // the joined header (~21 KB) exceeds Cloudflare's 16 KB aggregate limit.
      const manyTags = Array.from(
        { length: 100 },
        (_, i) => `t${i}-${"x".repeat(200)}`,
      );
      const put = vi.spyOn(mockCaches._default, "put");
      const store = makeStore({ tagPurge: vi.fn(async () => {}) });

      await store.set("k", createTestData(manyTags), 300);
      await ctx.flush();

      const dataPut = put.mock.calls.find(([req]) =>
        (req as Request).url.endsWith("/v/v1/k"),
      );
      // Header omitted (the entry still caches), warning surfaced once.
      expect((dataPut![1] as Response).headers.get("Cache-Tag")).toBeNull();
      expect(warn.mock.calls.map((c) => String(c[0])).join("\n")).toMatch(
        /Cache-Tag header.*omitted/s,
      );

      // A purge cannot evict this entry, so purge mode must NOT trust it:
      // invalidation still lands via the marker check, even cross-request.
      expect(
        await runWithRequestContext(makeReqCtx(), () => store.get("k")),
      ).not.toBeNull();
      vi.advanceTimersByTime(10);
      await store.invalidateTags([manyTags[0]!]);
      expect(
        await runWithRequestContext(makeReqCtx(), () => store.get("k")),
      ).toBeNull();
    });

    it("KV-less purge mode SKIPS caching an over-limit tag set (no invalidation path would exist)", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const manyTags = Array.from(
        { length: 100 },
        (_, i) => `t${i}-${"x".repeat(200)}`,
      );
      const put = vi.spyOn(mockCaches._default, "put");
      // No kv: the entry tokens would be the ONLY invalidation path, and the
      // overflow means it gets none — so the write must be rejected, not
      // cached un-invalidatable (there is no marker fallback to lean on).
      const store = new CFCacheStore({
        ctx: ctx as any,
        baseUrl: "https://test.internal/",
        version: "v1",
        tagPurge: vi.fn(async () => {}),
      });

      const acknowledgements = await Promise.all([
        store.set("k", createTestData(manyTags), 300),
        store.setItem("item", "v", { tags: manyTags }),
        store.putResponse("doc", new Response("<html/>"), 300, 0, manyTags),
      ]);
      await ctx.flush();

      expect(acknowledgements).toEqual([
        { outcome: "skipped", reason: "unsupported" },
        { outcome: "skipped", reason: "unsupported" },
        { outcome: "skipped", reason: "unsupported" },
      ]);
      expect(put).not.toHaveBeenCalled();
      expect(await store.get("k")).toBeNull();
      expect(warn.mock.calls.map((c) => String(c[0])).join("\n")).toMatch(
        /NOT cached/,
      );

      // Sanity: KV-less MARKER mode (no tagPurge) keeps caching the same tag
      // set with the header omitted — its documented semantics (tags have no
      // read-side invalidation without KV) are unchanged.
      const markerStore = new CFCacheStore({
        ctx: ctx as any,
        baseUrl: "https://test.internal/",
        version: "v1",
      });
      await markerStore.set("k2", createTestData(manyTags), 300);
      await ctx.flush();
      expect(await markerStore.get("k2")).not.toBeNull();
    });

    it("leaves untagged entries without a Cache-Tag header", async () => {
      const put = vi.spyOn(mockCaches._default, "put");
      const store = makeStore();
      await store.set("k", createTestData(), 300);
      await ctx.flush();

      const dataPut = put.mock.calls.find(([req]) =>
        (req as Request).url.endsWith("/v/v1/k"),
      );
      expect((dataPut![1] as Response).headers.get("Cache-Tag")).toBeNull();
    });

    it("appends to an author Cache-Tag on documents and strips only its own tokens on serve", async () => {
      const store = makeStore();
      await store.putResponse(
        "doc",
        new Response("<html/>", {
          headers: { "Cache-Tag": "author-tag", "Content-Type": "text/html" },
        }),
        300,
        0,
        ["products"],
      );
      await ctx.flush();

      const hit = await store.getResponse("doc");
      expect(hit).not.toBeNull();
      // Ours (rg:default*) removed, the author's token preserved.
      expect(hit!.response.headers.get("Cache-Tag")).toBe("author-tag");
    });

    it("deletes Cache-Tag from a served document when only internal tokens were present", async () => {
      const store = makeStore();
      await store.putResponse("doc", new Response("<html/>"), 300, 0, [
        "products",
      ]);
      await ctx.flush();

      const hit = await store.getResponse("doc");
      expect(hit).not.toBeNull();
      expect(hit!.response.headers.get("Cache-Tag")).toBeNull();
    });
  });

  describe("tagPurge credentials form", () => {
    it("normalizes { zoneId, apiToken } through the built-in zone purge client", async () => {
      const fetchImpl = vi.fn(
        async () =>
          new Response(JSON.stringify({ success: true }), { status: 200 }),
      );
      const store = makeStore({
        tagPurge: {
          zoneId: "zone123",
          apiToken: "tok",
          fetch: fetchImpl as unknown as typeof fetch,
        },
      });

      await store.invalidateTags(["products"]);

      expect(fetchImpl).toHaveBeenCalledTimes(1);
      const [url, init] = fetchImpl.mock.calls[0] as unknown as [
        string,
        RequestInit,
      ];
      expect(url).toBe(
        "https://api.cloudflare.com/client/v4/zones/zone123/purge_cache",
      );
      expect((init.headers as Record<string, string>).Authorization).toBe(
        "Bearer tok",
      );
      expect(JSON.parse(String(init.body))).toEqual({
        tags: ["rg:default:e:products"],
      });
    });

    it("purge mode is active with the credentials form (L1 hit skips the marker read)", async () => {
      const fetchImpl = vi.fn(
        async () =>
          new Response(JSON.stringify({ success: true }), { status: 200 }),
      );
      const store = makeStore({
        tagPurge: {
          zoneId: "z",
          apiToken: "t",
          fetch: fetchImpl as unknown as typeof fetch,
        },
      });
      await store.set("k", createTestData(["products"]), 300);
      await ctx.flush();

      const kvGet = vi.spyOn(kv, "get");
      expect(
        await runWithRequestContext(makeReqCtx(), () => store.get("k")),
      ).not.toBeNull();
      expect(
        kvGet.mock.calls.filter(([key]) =>
          String(key).includes(TAG_MARKER_PREFIX),
        ),
      ).toHaveLength(0);
    });

    it("rejects missing credentials at construction, not at the first updateTag", () => {
      expect(() =>
        makeStore({ tagPurge: { zoneId: "", apiToken: "t" } }),
      ).toThrow(/zoneId is required/);
      expect(() =>
        makeStore({ tagPurge: { zoneId: "z", apiToken: undefined } }),
      ).toThrow(/apiToken is required/);
    });
  });

  describe("invalidateTags purge call", () => {
    it("fires tagPurge once with the entry purge tags for the whole batch", async () => {
      const tagPurge = vi.fn(async (_tags: string[]) => {});
      const store = makeStore({ tagPurge });

      await store.invalidateTags(["products", "catalog"]);

      expect(tagPurge).toHaveBeenCalledTimes(1);
      expect(tagPurge).toHaveBeenCalledWith([
        "rg:default:e:products",
        "rg:default:e:catalog",
      ]);
    });

    it("includes the lookup tags when the L1 marker cache is active", async () => {
      const tagPurge = vi.fn(async (_tags: string[]) => {});
      const store = makeStore({ tagPurge, tagCacheTtl: 60 });

      await store.invalidateTags(["products"]);

      expect(tagPurge).toHaveBeenCalledWith([
        "rg:default:e:products",
        "rg:default:lk:products",
      ]);
    });

    it("rejects when tagPurge fails, after the KV markers were written", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const tagPurge = vi.fn(async () => {
        throw new Error("purge api down");
      });
      const store = makeStore({ tagPurge });

      await expect(store.invalidateTags(["products"])).rejects.toThrow(
        /tagPurge/,
      );
      // The durable marker landed regardless: KV/shell reads are protected
      // even while L1 stays stale until the retried purge.
      expect(kv.store.get(`v/v1/${TAG_MARKER_PREFIX}products`)).toBeDefined();
    });
  });

  describe("L1 read path", () => {
    it("serves a tagged L1 hit without a KV marker read", async () => {
      const store = makeStore({ tagPurge: vi.fn(async () => {}) });
      await store.set("k", createTestData(["products"]), 300);
      await ctx.flush();

      const kvGet = vi.spyOn(kv, "get");
      const hit = await runWithRequestContext(makeReqCtx(), () =>
        store.get("k"),
      );
      expect(hit).not.toBeNull();
      const markerReads = kvGet.mock.calls.filter(([key]) =>
        String(key).includes(TAG_MARKER_PREFIX),
      );
      expect(markerReads).toHaveLength(0);
    });

    it("still reads the KV marker on an L1 hit in marker mode (contrast)", async () => {
      const store = makeStore();
      await store.set("k", createTestData(["products"]), 300);
      await ctx.flush();

      const kvGet = vi.spyOn(kv, "get");
      const hit = await runWithRequestContext(makeReqCtx(), () =>
        store.get("k"),
      );
      expect(hit).not.toBeNull();
      const markerReads = kvGet.mock.calls.filter(([key]) =>
        String(key).includes(TAG_MARKER_PREFIX),
      );
      expect(markerReads).toHaveLength(1);
    });

    it("masks its own invalidation within the request (read-your-own-writes), and trusts surviving entries in a fresh request", async () => {
      // The stub records the purge but does NOT evict — simulating the purge
      // still propagating (or dropped).
      const tagPurge = vi.fn(async () => {});
      const store = makeStore({ tagPurge });
      await store.set("k", createTestData(["products"]), 300);
      await ctx.flush();

      await runWithRequestContext(makeReqCtx(), async () => {
        expect(await store.get("k")).not.toBeNull();
        vi.advanceTimersByTime(10);
        await store.invalidateTags(["products"]);
        // Same request: the memo masks the not-yet-purged entry.
        expect(await store.get("k")).toBeNull();
      });

      // A NEW request trusts the (un-purged) surviving L1 entry: eviction is
      // delegated to the purge — this pins purge mode's consistency contract.
      const later = await runWithRequestContext(makeReqCtx(), () =>
        store.get("k"),
      );
      expect(later).not.toBeNull();
    });

    it("KV fallback still enforces the markers in purge mode", async () => {
      const store = makeStore({ tagPurge: vi.fn(async () => {}) });
      await store.set("k", createTestData(["products"]), 300);
      await ctx.flush();

      // Sanity: with L1 cleared, the KV envelope serves.
      mockCaches.clear();
      expect(
        await runWithRequestContext(makeReqCtx(), () => store.get("k")),
      ).not.toBeNull();
      await ctx.flush(); // drain the KV->L1 promote

      vi.advanceTimersByTime(10);
      await store.invalidateTags(["products"]);

      // L1 gone again (as a real purge would leave it): the KV envelope must
      // NOT resurrect past the marker.
      mockCaches.clear();
      expect(
        await runWithRequestContext(makeReqCtx(), () => store.get("k")),
      ).toBeNull();
    });
  });

  describe("KV-less purge mode (L1-only store)", () => {
    function makeKvlessStore(tagPurge: (tags: string[]) => Promise<void>) {
      return new CFCacheStore({
        ctx: ctx as any,
        baseUrl: "https://test.internal/",
        version: "v1",
        tagPurge,
      });
    }

    it("invalidates within the request and fires the purge, with no misconfig warning", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const tagPurge = vi.fn(async () => {});
      const store = makeKvlessStore(tagPurge);

      await store.set("k", createTestData(["products"]), 300);
      await ctx.flush();

      await runWithRequestContext(makeReqCtx(), async () => {
        expect(await store.get("k")).not.toBeNull();
        vi.advanceTimersByTime(10);
        await store.invalidateTags(["products"]);
        expect(await store.get("k")).toBeNull();
      });

      // No lookup tags without KV (no lookup entries can exist).
      expect(tagPurge).toHaveBeenCalledWith(["rg:default:e:products"]);
      const warned = warn.mock.calls.map((c) => String(c[0])).join("\n");
      expect(warned).not.toMatch(/had no effect/);
      expect(warned).not.toMatch(/without a KV/);
    });
  });
});
