import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LoaderEntry } from "../server/context";
import type { SegmentCacheStore, CacheItemResult } from "../cache/types";

// Mock segment-codec (RSC serialization)
vi.mock("../cache/segment-codec.js", () => ({
  serializeResult: vi.fn(async (value: unknown) => JSON.stringify(value)),
  deserializeResult: vi.fn(async (encoded: string) => JSON.parse(encoded)),
}));

// Mock request context
const mockRequestCtx: any = {
  params: {},
  waitUntil: vi.fn((p: Promise<unknown> | (() => unknown)) => {
    // Execute immediately in tests
    if (typeof p === "function") {
      p();
    } else {
      p.catch(() => {});
    }
  }),
  _cacheStore: undefined,
};

vi.mock("../server/request-context.js", () => ({
  getRequestContext: vi.fn(() => mockRequestCtx),
  _getRequestContext: vi.fn(() => mockRequestCtx),
}));

// Mock internal debug
vi.mock("../internal-debug.js", () => ({
  INTERNAL_RANGO_DEBUG: false,
}));

import { resolveLoaderData } from "../router/segment-resolution/loader-cache";
import { serializeResult, deserializeResult } from "../cache/segment-codec";
import {
  getRequestContext,
  _getRequestContext,
} from "../server/request-context";

function createMockStore(
  overrides?: Partial<SegmentCacheStore>,
): SegmentCacheStore {
  return {
    get: vi.fn(async () => null),
    set: vi.fn(async () => {}),
    delete: vi.fn(async () => false),
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => {}),
    ...overrides,
  };
}

function createMockLoader(id: string, returnValue: unknown = { data: "test" }) {
  const fn = vi.fn(async () => returnValue);
  (fn as any).$$id = id;
  return fn;
}

function createMockCtx(params: Record<string, string> = {}) {
  const loaderPromises = new Map<string, Promise<unknown>>();
  const ctx: any = {
    params,
    use: vi.fn((loader: any) => {
      const id = loader.$$id;
      if (!loaderPromises.has(id)) {
        loaderPromises.set(id, loader());
      }
      return loaderPromises.get(id)!;
    }),
  };
  return ctx;
}

function createLoaderEntry(loader: any, cacheOptions?: any): LoaderEntry {
  return {
    loader,
    revalidate: [],
    cache: cacheOptions !== undefined ? { options: cacheOptions } : undefined,
  };
}

describe("loader-cache", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequestCtx._cacheStore = undefined;
  });

  // ==========================================================================
  // Zero-overhead path: no cache config
  // ==========================================================================

  describe("no cache config", () => {
    it("delegates to ctx.use when no cache config", async () => {
      const loader = createMockLoader("loader-1");
      const entry = createLoaderEntry(loader);
      const ctx = createMockCtx();

      await resolveLoaderData(entry, ctx, "/test");

      expect(ctx.use).toHaveBeenCalledWith(loader);
    });

    it("delegates to ctx.use when cache disabled (false)", async () => {
      const loader = createMockLoader("loader-2");
      const entry = createLoaderEntry(loader, false);
      const ctx = createMockCtx();

      await resolveLoaderData(entry, ctx, "/test");

      expect(ctx.use).toHaveBeenCalledWith(loader);
    });
  });

  // ==========================================================================
  // Cache key resolution (3-tier priority)
  // ==========================================================================

  describe("cache key resolution", () => {
    it("uses default key: loader:{id}:{pathname}", async () => {
      const store = createMockStore();
      const loader = createMockLoader("my-loader");
      const entry = createLoaderEntry(loader, { store });
      const ctx = createMockCtx();

      await resolveLoaderData(entry, ctx, "/products");

      expect(store.getItem).toHaveBeenCalledWith(
        "loader:my-loader:localhost/products",
      );
    });

    it("includes sorted params in default key", async () => {
      const store = createMockStore();
      const loader = createMockLoader("loader-params");
      const entry = createLoaderEntry(loader, { store });
      const ctx = createMockCtx({ z: "last", a: "first" });

      await resolveLoaderData(entry, ctx, "/items");

      expect(store.getItem).toHaveBeenCalledWith(
        "loader:loader-params:localhost/items:a=first&z=last",
      );
    });

    it("isolates the default key by host (no cross-host loader-cache leak)", async () => {
      // The route-level cache and "use cache" both key by host; the loader cache
      // must too, or a multi-tenant host router serving the same pathname for two
      // hosts would serve one host's cached loader data to the other.
      const keyFor = async (host: string) => {
        mockRequestCtx.url = { host, searchParams: new URLSearchParams() };
        const store = createMockStore();
        const loader = createMockLoader("tenant-loader");
        await resolveLoaderData(
          createLoaderEntry(loader, { store }),
          createMockCtx(),
          "/dashboard",
        );
        return (store.getItem as any).mock.calls[0][0] as string;
      };

      const keyA = await keyFor("a.example.com");
      const keyB = await keyFor("b.example.com");
      delete mockRequestCtx.url; // restore default host for the other tests

      expect(keyA).toContain("a.example.com");
      expect(keyB).toContain("b.example.com");
      expect(keyA).not.toBe(keyB);
    });

    it("priority 1: options.key overrides default", async () => {
      const store = createMockStore();
      const loader = createMockLoader("loader-custom-key");
      const entry = createLoaderEntry(loader, {
        store,
        key: async () => "custom-key-override",
      });
      const ctx = createMockCtx();

      await resolveLoaderData(entry, ctx, "/products");

      expect(store.getItem).toHaveBeenCalledWith("custom-key-override");
    });

    it("priority 2: store.keyGenerator modifies default key", async () => {
      const store = createMockStore({
        keyGenerator: vi.fn(
          async (_ctx, defaultKey) => `region:us:${defaultKey}`,
        ),
      });
      const loader = createMockLoader("loader-keygen");
      const entry = createLoaderEntry(loader, { store });
      const ctx = createMockCtx();

      await resolveLoaderData(entry, ctx, "/products");

      expect(store.keyGenerator).toHaveBeenCalledWith(
        mockRequestCtx,
        "loader:loader-keygen:localhost/products",
      );
      expect(store.getItem).toHaveBeenCalledWith(
        "region:us:loader:loader-keygen:localhost/products",
      );
    });

    it("options.key takes precedence over store.keyGenerator", async () => {
      const store = createMockStore({
        keyGenerator: vi.fn(async () => "should-not-be-used"),
      });
      const loader = createMockLoader("loader-precedence");
      const entry = createLoaderEntry(loader, {
        store,
        key: async () => "custom-key-wins",
      });
      const ctx = createMockCtx();

      await resolveLoaderData(entry, ctx, "/test");

      expect(store.keyGenerator).not.toHaveBeenCalled();
      expect(store.getItem).toHaveBeenCalledWith("custom-key-wins");
    });

    it("throws when options.key throws (hard-fail, no silent fallback)", async () => {
      const store = createMockStore();
      const loader = createMockLoader("loader-fallback");
      const entry = createLoaderEntry(loader, {
        store,
        key: async () => {
          throw new Error("key function failed");
        },
      });
      const ctx = createMockCtx();

      await expect(resolveLoaderData(entry, ctx, "/fallback")).rejects.toThrow(
        "key function failed",
      );
      expect(store.getItem).not.toHaveBeenCalled();
    });

    it("throws when store.keyGenerator throws (hard-fail, no silent fallback)", async () => {
      const store = createMockStore({
        keyGenerator: vi.fn(async () => {
          throw new Error("keyGenerator failed");
        }),
      });
      const loader = createMockLoader("loader-keygen-fail");
      const entry = createLoaderEntry(loader, { store });
      const ctx = createMockCtx();

      await expect(resolveLoaderData(entry, ctx, "/fallback")).rejects.toThrow(
        "keyGenerator failed",
      );
      expect(store.getItem).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // Cache hit / miss / stale
  // ==========================================================================

  describe("cache behavior", () => {
    it("returns cached data on hit (skips loader)", async () => {
      const cachedValue = { name: "cached product" };
      const store = createMockStore({
        getItem: vi.fn(
          async (): Promise<CacheItemResult> => ({
            value: JSON.stringify(cachedValue),
            shouldRevalidate: false,
          }),
        ),
      });
      const loader = createMockLoader("hit-loader", {
        name: "fresh product",
      });
      const entry = createLoaderEntry(loader, { store });
      const ctx = createMockCtx();

      const result = await resolveLoaderData(entry, ctx, "/product");

      expect(result).toEqual(cachedValue);
      // Loader should not have been called
      expect(loader).not.toHaveBeenCalled();
    });

    it("executes loader and caches on miss", async () => {
      const freshData = { name: "fresh product" };
      const store = createMockStore();
      const loader = createMockLoader("miss-loader", freshData);
      const entry = createLoaderEntry(loader, { ttl: 120, store });
      const ctx = createMockCtx();

      const result = await resolveLoaderData(entry, ctx, "/product");

      expect(result).toEqual(freshData);
      expect(store.setItem).toHaveBeenCalledWith(
        "loader:miss-loader:localhost/product",
        JSON.stringify(freshData),
        expect.objectContaining({ ttl: 120 }),
      );
    });

    it("returns stale data and triggers background revalidation", async () => {
      const staleData = { name: "stale" };
      const freshData = { name: "fresh" };
      const store = createMockStore({
        getItem: vi.fn(
          async (): Promise<CacheItemResult> => ({
            value: JSON.stringify(staleData),
            shouldRevalidate: true,
          }),
        ),
      });
      const loader = createMockLoader("swr-loader", freshData);
      const entry = createLoaderEntry(loader, { ttl: 60, swr: 300, store });
      const ctx = createMockCtx();

      const result = await resolveLoaderData(entry, ctx, "/product");

      // Should return stale data immediately
      expect(result).toEqual(staleData);
      // Background revalidation should have been scheduled
      expect(mockRequestCtx.waitUntil).toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // Null preservation
  // ==========================================================================

  describe("null result caching", () => {
    it("caches null loader results (does not skip write)", async () => {
      const store = createMockStore();
      const loader = createMockLoader("null-loader", null);
      const entry = createLoaderEntry(loader, { ttl: 60, store });
      const ctx = createMockCtx();

      const result = await resolveLoaderData(entry, ctx, "/nullable");

      expect(result).toBeNull();
      // serializeResult should have been called with null
      expect(serializeResult).toHaveBeenCalledWith(null);
      // The mock returns "null" (JSON.stringify(null)), which is not null,
      // so setItem should be called
      expect(store.setItem).toHaveBeenCalledWith(
        "loader:null-loader:localhost/nullable",
        "null",
        expect.objectContaining({ ttl: 60 }),
      );
    });

    it("returns null from cache hit (round-trip)", async () => {
      const store = createMockStore({
        getItem: vi.fn(
          async (): Promise<CacheItemResult> => ({
            value: "null",
            shouldRevalidate: false,
          }),
        ),
      });
      const loader = createMockLoader("null-hit", "should-not-run");
      const entry = createLoaderEntry(loader, { store });
      const ctx = createMockCtx();

      const result = await resolveLoaderData(entry, ctx, "/nullable");

      expect(result).toBeNull();
      expect(loader).not.toHaveBeenCalled();
    });

    it("skips cache write when serialization fails (returns null)", async () => {
      const store = createMockStore();
      const loader = createMockLoader("fail-serialize", { data: "test" });
      vi.mocked(serializeResult).mockResolvedValueOnce(null);
      const entry = createLoaderEntry(loader, { ttl: 60, store });
      const ctx = createMockCtx();

      await resolveLoaderData(entry, ctx, "/fail");

      expect(store.setItem).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // Tags
  // ==========================================================================

  describe("tags", () => {
    it("passes static tags to store.setItem", async () => {
      const store = createMockStore();
      const loader = createMockLoader("tags-loader");
      const entry = createLoaderEntry(loader, {
        ttl: 60,
        store,
        tags: ["products", "catalog"],
      });
      const ctx = createMockCtx();

      await resolveLoaderData(entry, ctx, "/products");

      expect(store.setItem).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        expect.objectContaining({ tags: ["products", "catalog"] }),
      );
    });

    it("resolves function-based tags with request context", async () => {
      const store = createMockStore();
      const loader = createMockLoader("dynamic-tags");
      const entry = createLoaderEntry(loader, {
        ttl: 60,
        store,
        tags: () => ["product:123", "products"],
      });
      const ctx = createMockCtx();

      await resolveLoaderData(entry, ctx, "/product/123");

      expect(store.setItem).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        expect.objectContaining({ tags: ["product:123", "products"] }),
      );
    });

    it("falls back to no tags when tag function throws", async () => {
      const consoleError = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});
      const store = createMockStore();
      const loader = createMockLoader("tags-fail");
      const entry = createLoaderEntry(loader, {
        ttl: 60,
        store,
        tags: () => {
          throw new Error("tag resolution failed");
        },
      });
      const ctx = createMockCtx();

      await resolveLoaderData(entry, ctx, "/test");

      // Should still cache, just without tags
      expect(store.setItem).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        expect.objectContaining({ tags: undefined }),
      );
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining("Tags function failed"),
        expect.any(Error),
      );
      consoleError.mockRestore();
    });
  });

  // ==========================================================================
  // TTL / SWR resolution
  // ==========================================================================

  describe("TTL and SWR resolution", () => {
    it("uses route-level ttl when specified", async () => {
      const store = createMockStore();
      const loader = createMockLoader("ttl-route");
      const entry = createLoaderEntry(loader, { ttl: 300, store });
      const ctx = createMockCtx();

      await resolveLoaderData(entry, ctx, "/test");

      expect(store.setItem).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        expect.objectContaining({ ttl: 300 }),
      );
    });

    it("falls back to store defaults when no route-level ttl", async () => {
      const store = createMockStore({ defaults: { ttl: 180 } });
      const loader = createMockLoader("ttl-default");
      const entry = createLoaderEntry(loader, { store });
      const ctx = createMockCtx();

      await resolveLoaderData(entry, ctx, "/test");

      expect(store.setItem).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        expect.objectContaining({ ttl: 180 }),
      );
    });

    it("uses default 60s TTL when neither route nor store specify", async () => {
      const store = createMockStore();
      const loader = createMockLoader("ttl-fallback");
      const entry = createLoaderEntry(loader, { store });
      const ctx = createMockCtx();

      await resolveLoaderData(entry, ctx, "/test");

      expect(store.setItem).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        expect.objectContaining({ ttl: 60 }),
      );
    });

    it("passes swr from route options", async () => {
      const store = createMockStore();
      const loader = createMockLoader("swr-route");
      const entry = createLoaderEntry(loader, { ttl: 60, swr: 300, store });
      const ctx = createMockCtx();

      await resolveLoaderData(entry, ctx, "/test");

      expect(store.setItem).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        expect.objectContaining({ swr: 300 }),
      );
    });
  });

  // ==========================================================================
  // Condition
  // ==========================================================================

  describe("runtime condition", () => {
    it("skips cache when condition returns false", async () => {
      const store = createMockStore();
      const loader = createMockLoader("cond-skip");
      const entry = createLoaderEntry(loader, {
        ttl: 60,
        store,
        condition: () => false,
      });
      const ctx = createMockCtx();

      await resolveLoaderData(entry, ctx, "/test");

      // Should use ctx.use directly, not check cache
      expect(store.getItem).not.toHaveBeenCalled();
    });

    it("uses cache when condition returns true", async () => {
      const store = createMockStore();
      const loader = createMockLoader("cond-use");
      const entry = createLoaderEntry(loader, {
        ttl: 60,
        store,
        condition: () => true,
      });
      const ctx = createMockCtx();

      await resolveLoaderData(entry, ctx, "/test");

      expect(store.getItem).toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // Store resolution
  // ==========================================================================

  describe("store resolution", () => {
    it("uses store from cache options", async () => {
      const store = createMockStore();
      const loader = createMockLoader("store-opts");
      const entry = createLoaderEntry(loader, { ttl: 60, store });
      const ctx = createMockCtx();

      await resolveLoaderData(entry, ctx, "/test");

      expect(store.getItem).toHaveBeenCalled();
    });

    it("falls back to app-level store from request context", async () => {
      const appStore = createMockStore();
      mockRequestCtx._cacheStore = appStore;
      const loader = createMockLoader("store-app");
      const entry = createLoaderEntry(loader, { ttl: 60 });
      const ctx = createMockCtx();

      await resolveLoaderData(entry, ctx, "/test");

      expect(appStore.getItem).toHaveBeenCalled();
    });

    it("delegates to ctx.use when no store available", async () => {
      const loader = createMockLoader("no-store");
      const entry = createLoaderEntry(loader, { ttl: 60 });
      const ctx = createMockCtx();

      await resolveLoaderData(entry, ctx, "/test");

      // No store found, so should fall through to ctx.use
      expect(ctx.use).toHaveBeenCalledWith(loader);
    });
  });

  // ==========================================================================
  // ctx.use wrapping
  // ==========================================================================

  describe("ctx.use wrapping", () => {
    it("wraps ctx.use so handler gets cached data", async () => {
      const cachedValue = { name: "cached" };
      const store = createMockStore({
        getItem: vi.fn(
          async (): Promise<CacheItemResult> => ({
            value: JSON.stringify(cachedValue),
            shouldRevalidate: false,
          }),
        ),
      });
      const loader = createMockLoader("wrap-test");
      const entry = createLoaderEntry(loader, { store });
      const ctx = createMockCtx();

      // Start the cache resolution
      const dataPromise = resolveLoaderData(entry, ctx, "/test");

      // The handler would call ctx.use(loader) which should return the same data
      const handlerResult = ctx.use(loader);
      const [data, handlerData] = await Promise.all([
        dataPromise,
        handlerResult,
      ]);

      expect(data).toEqual(cachedValue);
      expect(handlerData).toEqual(cachedValue);
    });

    it("does not intercept ctx.use for other loaders", async () => {
      const store = createMockStore();
      const loader1 = createMockLoader("loader-1");
      const loader2 = createMockLoader("loader-2", { other: true });
      const entry = createLoaderEntry(loader1, { store });
      const ctx = createMockCtx();
      const originalUse = ctx.use;

      resolveLoaderData(entry, ctx, "/test");

      // ctx.use for a different loader should not be intercepted
      // It should call through to the original
      const result = await ctx.use(loader2);
      expect(result).toEqual({ other: true });
    });
  });
});
