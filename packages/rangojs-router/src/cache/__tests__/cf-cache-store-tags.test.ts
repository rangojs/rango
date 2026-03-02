import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import {
  CFCacheStore,
  CFEdgeKVCacheStore,
  CFKVTagInvalidationStore,
  CACHE_TAGS_HEADER,
  type CFTagInvalidationStore,
} from "../cf/cf-cache-store.js";

// ---------------------------------------------------------------------------
// Mock the virtual module and requestContext imports
// ---------------------------------------------------------------------------

vi.mock("@rangojs/router:version", () => ({ VERSION: "test-v1" }));
vi.mock("../../server/request-context.js", () => ({
  getRequestContext: () => null,
}));

// ---------------------------------------------------------------------------
// Minimal CF Cache API mock
// ---------------------------------------------------------------------------

function createMockCache() {
  const store = new Map<string, Response>();
  return {
    match: vi.fn(async (req: Request) => {
      const res = store.get(req.url);
      return res ? res.clone() : undefined;
    }),
    put: vi.fn(async (req: Request, res: Response) => {
      store.set(req.url, res.clone());
    }),
    delete: vi.fn(async (req: Request) => store.delete(req.url)),
    _store: store,
  };
}

function createMockCtx() {
  const pending: Promise<void>[] = [];
  return {
    waitUntil: vi.fn((p: Promise<any>) => {
      pending.push(p);
    }),
    passThroughOnException: vi.fn(),
    flush: () => Promise.all(pending),
  };
}

function createMockTagInvalidationStore() {
  const invalidatedAt = new Map<string, number>();
  const store: CFTagInvalidationStore = {
    async getLatestInvalidation(tags: string[]) {
      let latest: number | null = null;
      for (const tag of tags) {
        const timestamp = invalidatedAt.get(tag);
        if (timestamp === undefined) continue;
        latest = latest === null ? timestamp : Math.max(latest, timestamp);
      }
      return latest;
    },
    async revalidateTag(tag: string, at: number) {
      invalidatedAt.set(tag, at);
    },
  };

  return {
    store,
    invalidatedAt,
    revalidateTag: vi.spyOn(store, "revalidateTag"),
    getLatestInvalidation: vi.spyOn(store, "getLatestInvalidation"),
  };
}

function createMockKV() {
  const data = new Map<string, string>();
  return {
    get: vi.fn(async (key: string) => data.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      data.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      data.delete(key);
    }),
    data,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CFCacheStore tag support", () => {
  let mockCache: ReturnType<typeof createMockCache>;
  let mockCtx: ReturnType<typeof createMockCtx>;

  beforeEach(() => {
    mockCache = createMockCache();
    mockCtx = createMockCtx();

    // Install mock as caches.default
    (globalThis as any).caches = { default: mockCache };
  });

  function createStore(options?: {
    onRevalidateTag?: (tags: string[]) => Promise<void>;
    tagInvalidationStore?: CFTagInvalidationStore;
  }) {
    return new CFCacheStore({
      ctx: mockCtx,
      baseUrl: "https://test.internal/",
      version: "v1",
      onRevalidateTag: options?.onRevalidateTag,
      tagInvalidationStore: options?.tagInvalidationStore,
    });
  }

  // ========================================================================
  // Tag headers on write
  // ========================================================================

  describe("tag headers on set()", () => {
    it("stores x-edge-cache-tags header when data has tags", async () => {
      const store = createStore();
      await store.set(
        "key1",
        {
          segments: [],
          handles: {},
          expiresAt: Date.now() + 60000,
          tags: ["products", "featured"],
        },
        60,
      );
      await mockCtx.flush();

      const putCall = mockCache.put.mock.calls[0]!;
      const storedResponse = putCall[1] as Response;
      expect(storedResponse.headers.get(CACHE_TAGS_HEADER)).toBe(
        "products,featured",
      );
    });

    it("omits x-edge-cache-tags header when data has no tags", async () => {
      const store = createStore();
      await store.set(
        "key1",
        { segments: [], handles: {}, expiresAt: Date.now() + 60000 },
        60,
      );
      await mockCtx.flush();

      const putCall = mockCache.put.mock.calls[0]!;
      const storedResponse = putCall[1] as Response;
      expect(storedResponse.headers.has(CACHE_TAGS_HEADER)).toBe(false);
    });
  });

  describe("tag headers on setItem()", () => {
    it("stores x-edge-cache-tags header when options have tags", async () => {
      const store = createStore();
      await store.setItem("fn-key", "serialized-value", {
        ttl: 60,
        tags: ["api", "users"],
      });
      await mockCtx.flush();

      const putCall = mockCache.put.mock.calls[0]!;
      const storedResponse = putCall[1] as Response;
      expect(storedResponse.headers.get(CACHE_TAGS_HEADER)).toBe("api,users");
    });

    it("omits x-edge-cache-tags header when options have no tags", async () => {
      const store = createStore();
      await store.setItem("fn-key", "serialized-value", { ttl: 60 });
      await mockCtx.flush();

      const putCall = mockCache.put.mock.calls[0]!;
      const storedResponse = putCall[1] as Response;
      expect(storedResponse.headers.has(CACHE_TAGS_HEADER)).toBe(false);
    });
  });

  describe("tag headers on putResponse()", () => {
    it("stores x-edge-cache-tags header when tags are provided", async () => {
      const store = createStore();
      await store.putResponse("doc-key", new Response("body"), 60, undefined, [
        "page",
        "layout",
      ]);
      await mockCtx.flush();

      const putCall = mockCache.put.mock.calls[0]!;
      const storedResponse = putCall[1] as Response;
      expect(storedResponse.headers.get(CACHE_TAGS_HEADER)).toBe("page,layout");
    });

    it("omits x-edge-cache-tags header when no tags", async () => {
      const store = createStore();
      await store.putResponse("doc-key", new Response("body"), 60);
      await mockCtx.flush();

      const putCall = mockCache.put.mock.calls[0]!;
      const storedResponse = putCall[1] as Response;
      expect(storedResponse.headers.has(CACHE_TAGS_HEADER)).toBe(false);
    });
  });

  // ========================================================================
  // Distributed invalidation store
  // ========================================================================

  describe("tag invalidation store", () => {
    it("treats tagged segment entries as misses after global invalidation", async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
        const tagStore = createMockTagInvalidationStore();
        const store = createStore({ tagInvalidationStore: tagStore.store });

        await store.set(
          "key1",
          {
            segments: [],
            handles: {},
            expiresAt: Date.now() + 60000,
            tags: ["products"],
          },
          60,
        );
        await mockCtx.flush();

        vi.advanceTimersByTime(1000);
        await store.revalidateTag("products");
        await mockCtx.flush();

        expect(await store.get("key1")).toBeNull();
        expect(tagStore.revalidateTag).toHaveBeenCalledWith(
          "products",
          Date.now(),
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it("treats tagged function entries as misses after global invalidation", async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
        const tagStore = createMockTagInvalidationStore();
        const store = createStore({ tagInvalidationStore: tagStore.store });

        await store.setItem("fn-key", "serialized-value", {
          ttl: 60,
          tags: ["users"],
        });
        await mockCtx.flush();

        vi.advanceTimersByTime(1000);
        await store.revalidateTag("users");
        await mockCtx.flush();

        expect(await store.getItem("fn-key")).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it("treats tagged response entries as misses after global invalidation", async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
        const tagStore = createMockTagInvalidationStore();
        const store = createStore({ tagInvalidationStore: tagStore.store });

        await store.putResponse(
          "doc-key",
          new Response("body"),
          60,
          undefined,
          ["page"],
        );
        await mockCtx.flush();

        vi.advanceTimersByTime(1000);
        await store.revalidateTag("page");
        await mockCtx.flush();

        expect(await store.getResponse("doc-key")).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not invalidate untagged entries when global tag state changes", async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
        const tagStore = createMockTagInvalidationStore();
        const store = createStore({ tagInvalidationStore: tagStore.store });

        await store.set(
          "key1",
          { segments: [], handles: {}, expiresAt: Date.now() + 60000 },
          60,
        );
        await mockCtx.flush();

        vi.advanceTimersByTime(1000);
        await store.revalidateTag("products");
        await mockCtx.flush();

        expect(await store.get("key1")).not.toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it("can update distributed invalidation state and call onRevalidateTag", async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
        const tagStore = createMockTagInvalidationStore();
        const onInvalidation = vi.fn(async () => {});
        const store = createStore({
          tagInvalidationStore: tagStore.store,
          onRevalidateTag: onInvalidation,
        });

        await store.revalidateTag("products");
        await mockCtx.flush();

        expect(tagStore.revalidateTag).toHaveBeenCalledWith(
          "products",
          Date.now(),
        );
        expect(onInvalidation).toHaveBeenCalledWith(["products"]);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // ========================================================================
  // onRevalidateTag callback
  // ========================================================================

  describe("revalidateTag()", () => {
    it("calls onRevalidateTag via waitUntil with the tag", async () => {
      const onInvalidation = vi.fn(async () => {});
      const store = createStore({ onRevalidateTag: onInvalidation });

      await store.revalidateTag("products");
      await mockCtx.flush();

      expect(onInvalidation).toHaveBeenCalledWith(["products"]);
      expect(mockCtx.waitUntil).toHaveBeenCalled();
    });

    it("warns when no onRevalidateTag callback is configured", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const store = createStore();

      await store.revalidateTag("products");

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("no invalidation handler"),
      );
      warnSpy.mockRestore();
    });

    it("does not call waitUntil when no callback is configured", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const store = createStore();

      await store.revalidateTag("products");

      // waitUntil should not be called for tag invalidation
      // (it may be called for other reasons, so check no tag-related call)
      expect(mockCtx.waitUntil).not.toHaveBeenCalled();
      vi.restoreAllMocks();
    });

    it("handles callback errors gracefully", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const failingCallback = vi.fn(async () => {
        throw new Error("purge API failed");
      });
      const store = createStore({ onRevalidateTag: failingCallback });

      // Should not throw
      await store.revalidateTag("products");
      // Flush the waitUntil promise (which will reject)
      await mockCtx.flush().catch(() => {});

      expect(failingCallback).toHaveBeenCalledWith(["products"]);
      errorSpy.mockRestore();
    });
  });
});

describe("CFKVTagInvalidationStore", () => {
  it("stores invalidation timestamps and returns the latest one across tags", async () => {
    const kv = createMockKV();
    const store = new CFKVTagInvalidationStore(kv);

    await store.revalidateTag("products", 100);
    await store.revalidateTag("catalog", 200);

    expect(await store.getLatestInvalidation(["products"])).toBe(100);
    expect(await store.getLatestInvalidation(["products", "catalog"])).toBe(
      200,
    );
    expect(await store.getLatestInvalidation(["missing"])).toBeNull();
  });
});

describe("CFEdgeKVCacheStore", () => {
  let mockCache: ReturnType<typeof createMockCache>;
  let mockCtx: ReturnType<typeof createMockCtx>;
  let mockKV: ReturnType<typeof createMockKV>;

  beforeEach(() => {
    mockCache = createMockCache();
    mockCtx = createMockCtx();
    mockKV = createMockKV();
    (globalThis as any).caches = { default: mockCache };
  });

  function createStore(options?: {
    onRevalidateTag?: (tags: string[]) => Promise<void>;
  }) {
    return new CFEdgeKVCacheStore({
      ctx: mockCtx,
      baseUrl: "https://test.internal/",
      version: "v1",
      kv: mockKV,
      onRevalidateTag: options?.onRevalidateTag,
    });
  }

  it("falls back to KV on segment miss and repopulates edge", async () => {
    const writer = createStore();
    await writer.set(
      "key1",
      {
        segments: [],
        handles: {},
        expiresAt: Date.now() + 60000,
        tags: ["products"],
      },
      60,
    );
    await mockCtx.flush();

    const freshEdge = createMockCache();
    (globalThis as any).caches = { default: freshEdge };

    const reader = createStore();
    const result = await reader.get("key1");
    await mockCtx.flush();

    expect(result).not.toBeNull();
    expect(result!.data.tags).toEqual(["products"]);
    expect(freshEdge.put).toHaveBeenCalled();
  });

  it("falls back to KV on function miss and repopulates edge", async () => {
    const writer = createStore();
    await writer.setItem("fn-key", "serialized-value", {
      ttl: 60,
      tags: ["users"],
    });
    await mockCtx.flush();

    const freshEdge = createMockCache();
    (globalThis as any).caches = { default: freshEdge };

    const reader = createStore();
    const result = await reader.getItem!("fn-key");
    await mockCtx.flush();

    expect(result).not.toBeNull();
    expect(result!.value).toBe("serialized-value");
    expect(freshEdge.put).toHaveBeenCalled();
  });

  it("falls back to KV on response miss and repopulates edge", async () => {
    const writer = createStore();
    await writer.putResponse!("doc-key", new Response("body"), 60, undefined, [
      "page",
    ]);
    await mockCtx.flush();

    const freshEdge = createMockCache();
    (globalThis as any).caches = { default: freshEdge };

    const reader = createStore();
    const result = await reader.getResponse!("doc-key");
    await mockCtx.flush();

    expect(result).not.toBeNull();
    expect(await result!.response.text()).toBe("body");
    expect(freshEdge.put).toHaveBeenCalled();
  });

  it("uses shared KV tag invalidation to reject stale KV fallback hits", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      const writer = createStore();
      await writer.set(
        "key1",
        {
          segments: [],
          handles: {},
          expiresAt: Date.now() + 60000,
          tags: ["products"],
        },
        60,
      );
      await mockCtx.flush();

      vi.advanceTimersByTime(1000);
      await writer.revalidateTag("products");
      await mockCtx.flush();

      const freshEdge = createMockCache();
      (globalThis as any).caches = { default: freshEdge };

      const reader = createStore();
      expect(await reader.get("key1")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns shouldRevalidate: true for stale KV fallback within SWR window", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      const writer = createStore();
      await writer.set(
        "key1",
        {
          segments: [],
          handles: {},
          expiresAt: Date.now() + 120_000,
        },
        10, // ttl: 10s
        60, // swr: 60s
      );
      await mockCtx.flush();

      // Advance past ttl but within swr window
      vi.advanceTimersByTime(15_000);

      // Clear edge cache to force KV fallback
      const freshEdge = createMockCache();
      (globalThis as any).caches = { default: freshEdge };

      const reader = createStore();
      const result = await reader.get("key1");
      await mockCtx.flush();

      expect(result).not.toBeNull();
      expect(result!.shouldRevalidate).toBe(true);
      // Verify edge was repopulated from KV
      expect(freshEdge.put).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("updates distributed invalidation state and optional purge callback", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      const onInvalidation = vi.fn(async () => {});
      const store = createStore({ onRevalidateTag: onInvalidation });

      await store.revalidateTag("products");
      await mockCtx.flush();

      const tagStore = new CFKVTagInvalidationStore(mockKV);
      expect(await tagStore.getLatestInvalidation(["products"])).toBe(
        Date.now(),
      );
      expect(onInvalidation).toHaveBeenCalledWith(["products"]);
    } finally {
      vi.useRealTimers();
    }
  });
});
