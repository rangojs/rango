import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  CFCacheStore,
  CACHE_STALE_AT_HEADER,
  CACHE_STATUS_HEADER,
  MAX_REVALIDATION_INTERVAL,
} from "../cf-cache-store";
import type { CachedEntryData } from "../../types";
import { runWithRequestContext } from "../../../server/request-context";

// ============================================================================
// Mock Cloudflare Cache API
// ============================================================================

class MockCache {
  private store = new Map<string, Response>();

  async match(request: Request): Promise<Response | undefined> {
    return this.store.get(request.url)?.clone();
  }

  async put(request: Request, response: Response): Promise<void> {
    this.store.set(request.url, response.clone());
  }

  async delete(request: Request): Promise<boolean> {
    return this.store.delete(request.url);
  }

  clear(): void {
    this.store.clear();
  }
}

class MockCaches {
  private caches = new Map<string, MockCache>();
  private _default = new MockCache();

  async open(name: string): Promise<MockCache> {
    if (!this.caches.has(name)) {
      this.caches.set(name, new MockCache());
    }
    return this.caches.get(name)!;
  }

  get default(): MockCache {
    return this._default;
  }

  clear(): void {
    this._default.clear();
    this.caches.forEach((cache) => cache.clear());
    this.caches.clear();
  }
}

// Install mock globally
const mockCaches = new MockCaches();
(globalThis as any).caches = mockCaches;

// ============================================================================
// Mock ExecutionContext
// ============================================================================

const createMockCtx = () => ({
  waitUntil: vi.fn((p: Promise<any>) => p),
  passThroughOnException: vi.fn(),
});

// ============================================================================
// Test Data
// ============================================================================

const createTestData = (): CachedEntryData => ({
  segments: [
    {
      encoded: "test-component",
      metadata: {
        id: "test-segment",
        type: "route",
        namespace: "test",
        index: 0,
        params: {},
      },
    },
  ],
  handles: "",
  expiresAt: Date.now() + 60000,
});

// A handle blob is now an opaque RSC-Flight-encoded STRING (handle-snapshot.ts
// encodeHandles), not a raw Record — Promise/ReactNode handle values would be
// destroyed by JSON.stringify if persisted raw. The store must round-trip the
// string verbatim through L1/L2/KV. Includes quotes/newlines/unicode so the
// JSON-serializing paths are exercised against a non-trivial payload.
const ENCODED_HANDLES =
  '1:{"seg1":{"breadcrumbs":["Home","Caf\\u00e9"]}}\n2:"x"';

// ============================================================================
// Tests
// ============================================================================

describe("CFCacheStore", () => {
  beforeEach(() => {
    mockCaches.clear();
    vi.useFakeTimers();
  });

  describe("constructor", () => {
    it("should require ctx", () => {
      expect(() => new CFCacheStore({} as any)).toThrow(
        "[CFCacheStore] ExecutionContext (ctx) is required",
      );
    });

    it("should accept ctx and custom options", () => {
      const store = new CFCacheStore({
        ctx: createMockCtx(),
        namespace: "custom-cache",
        baseUrl: "https://custom.internal/",
        defaults: { ttl: 120, swr: 600 },
      });
      expect(store.defaults).toEqual({ ttl: 120, swr: 600 });
    });
  });

  describe("get/set", () => {
    it("should return null for missing key", async () => {
      const store = new CFCacheStore({ ctx: createMockCtx() });
      const result = await store.get("missing-key");
      expect(result).toBeNull();
    });

    it("should store and retrieve data", async () => {
      const mockCtx = createMockCtx();
      const store = new CFCacheStore({ ctx: mockCtx });
      const data = createTestData();

      await store.set("test-key", data, 60);
      // Execute waitUntil callback
      await mockCtx.waitUntil.mock.results[0].value;

      const result = await store.get("test-key");

      expect(result).not.toBeNull();
      expect(result!.data).toEqual(data);
      expect(result!.shouldRevalidate).toBe(false);
    });

    it("should set Cache-Control header with TTL", async () => {
      const mockCtx = createMockCtx();
      const store = new CFCacheStore({ ctx: mockCtx });
      const data = createTestData();

      await store.set("test-key", data, 60);
      await mockCtx.waitUntil.mock.results[0].value;

      // Uses caches.default by default
      const cache = mockCaches.default;
      const request = new Request("https://rsc-dummy-host-1.com/test-key");
      const response = await cache.match(request);

      expect(response?.headers.get("Cache-Control")).toBe("public, max-age=60");
    });

    it("should extend TTL with SWR window", async () => {
      const mockCtx = createMockCtx();
      const store = new CFCacheStore({ ctx: mockCtx });
      const data = createTestData();

      await store.set("test-key", data, 60, 300);
      await mockCtx.waitUntil.mock.results[0].value;

      const cache = mockCaches.default;
      const request = new Request("https://rsc-dummy-host-1.com/test-key");
      const response = await cache.match(request);

      expect(response?.headers.get("Cache-Control")).toBe(
        "public, max-age=360",
      );
    });

    it("should use store defaults for SWR if not provided", async () => {
      const mockCtx = createMockCtx();
      const store = new CFCacheStore({ ctx: mockCtx, defaults: { swr: 120 } });
      const data = createTestData();

      await store.set("test-key", data, 60);
      await mockCtx.waitUntil.mock.results[0].value;

      const cache = mockCaches.default;
      const request = new Request("https://rsc-dummy-host-1.com/test-key");
      const response = await cache.match(request);

      expect(response?.headers.get("Cache-Control")).toBe(
        "public, max-age=180",
      );
    });

    it("should use named cache when namespace is provided", async () => {
      const mockCtx = createMockCtx();
      const store = new CFCacheStore({
        ctx: mockCtx,
        namespace: "custom-cache",
      });
      const data = createTestData();

      await store.set("test-key", data, 60);
      await mockCtx.waitUntil.mock.results[0].value;

      const cache = await mockCaches.open("custom-cache");
      const request = new Request("https://rsc-dummy-host-1.com/test-key");
      const response = await cache.match(request);

      expect(response?.headers.get("Cache-Control")).toBe("public, max-age=60");
    });

    it("should use waitUntil for non-blocking writes", async () => {
      const mockCtx = createMockCtx();
      const store = new CFCacheStore({ ctx: mockCtx });
      const data = createTestData();

      await store.set("test-key", data, 60);

      expect(mockCtx.waitUntil).toHaveBeenCalledTimes(1);
      expect(mockCtx.waitUntil).toHaveBeenCalledWith(expect.any(Promise));

      // Wait for the write to complete
      await mockCtx.waitUntil.mock.results[0].value;

      // Now the entry should be in cache
      const result = await store.get("test-key");
      expect(result).not.toBeNull();
    });
  });

  describe("staleness headers", () => {
    it("should set stale-at header based on TTL", async () => {
      vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));

      const mockCtx = createMockCtx();
      const store = new CFCacheStore({ ctx: mockCtx });
      const data = createTestData();

      await store.set("test-key", data, 60);
      await mockCtx.waitUntil.mock.results[0].value;

      const cache = mockCaches.default;
      const request = new Request("https://rsc-dummy-host-1.com/test-key");
      const response = await cache.match(request);

      const staleAt = Number(response?.headers.get(CACHE_STALE_AT_HEADER));
      const expectedStaleAt = Date.now() + 60 * 1000;

      expect(staleAt).toBe(expectedStaleAt);
    });

    it("should set status header to HIT", async () => {
      const mockCtx = createMockCtx();
      const store = new CFCacheStore({ ctx: mockCtx });
      const data = createTestData();

      await store.set("test-key", data, 60);
      await mockCtx.waitUntil.mock.results[0].value;

      const cache = mockCaches.default;
      const request = new Request("https://rsc-dummy-host-1.com/test-key");
      const response = await cache.match(request);

      expect(response?.headers.get(CACHE_STATUS_HEADER)).toBe("HIT");
    });
  });

  describe("staleness detection and atomic revalidation", () => {
    it("should return shouldRevalidate=false for fresh entries", async () => {
      vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));

      const mockCtx = createMockCtx();
      const store = new CFCacheStore({ ctx: mockCtx });
      const data = createTestData();

      await store.set("test-key", data, 60);
      await mockCtx.waitUntil.mock.results[0].value;

      // Still fresh
      vi.advanceTimersByTime(30 * 1000);

      const result = await store.get("test-key");
      expect(result?.shouldRevalidate).toBe(false);
    });

    it("should return shouldRevalidate=true and atomically mark REVALIDATING for stale entries", async () => {
      vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));

      const mockCtx = createMockCtx();
      const store = new CFCacheStore({ ctx: mockCtx });
      const data = createTestData();

      await store.set("test-key", data, 60, 300);
      await mockCtx.waitUntil.mock.results[0].value;

      // Past TTL but within SWR window
      vi.advanceTimersByTime(120 * 1000);

      // First get should return shouldRevalidate=true and mark as REVALIDATING
      const result = await store.get("test-key");
      expect(result?.shouldRevalidate).toBe(true);

      // Verify the entry is now marked as REVALIDATING
      const cache = mockCaches.default;
      const request = new Request(
        "https://rsc-dummy-host-1.com/" + encodeURIComponent("test-key"),
      );
      const response = await cache.match(request);
      expect(response?.headers.get(CACHE_STATUS_HEADER)).toBe("REVALIDATING");
    });

    it("should return shouldRevalidate=false when already REVALIDATING", async () => {
      vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));

      const mockCtx = createMockCtx();
      const store = new CFCacheStore({ ctx: mockCtx });
      const data = createTestData();

      await store.set("test-key", data, 60, 300);
      await mockCtx.waitUntil.mock.results[0].value;

      // Make it stale
      vi.advanceTimersByTime(120 * 1000);

      // First get - atomically marks as REVALIDATING
      const result1 = await store.get("test-key");
      expect(result1?.shouldRevalidate).toBe(true);

      // Second get - already REVALIDATING, should not trigger again
      const result2 = await store.get("test-key");
      expect(result2?.shouldRevalidate).toBe(false);
    });

    it("should prevent thundering herd with sequential requests", async () => {
      // Note: Real thundering herd prevention relies on CF Cache API's atomic semantics.
      // This test verifies sequential requests work correctly - first triggers revalidation,
      // subsequent ones see REVALIDATING status and don't trigger again.
      vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));

      const mockCtx = createMockCtx();
      const store = new CFCacheStore({ ctx: mockCtx });
      const data = createTestData();

      await store.set("test-key", data, 60, 300);
      await mockCtx.waitUntil.mock.results[0].value;

      // Make it stale
      vi.advanceTimersByTime(120 * 1000);

      // Sequential requests - first triggers revalidation
      const result1 = await store.get("test-key");
      expect(result1?.shouldRevalidate).toBe(true);
      expect(result1?.data).toBeDefined();

      // Subsequent requests see REVALIDATING status
      const result2 = await store.get("test-key");
      expect(result2?.shouldRevalidate).toBe(false);
      expect(result2?.data).toBeDefined();

      const result3 = await store.get("test-key");
      expect(result3?.shouldRevalidate).toBe(false);
      expect(result3?.data).toBeDefined();
    });
  });

  describe("delete", () => {
    it("should delete existing entry", async () => {
      const mockCtx = createMockCtx();
      const store = new CFCacheStore({ ctx: mockCtx });
      const data = createTestData();

      await store.set("test-key", data, 60);
      await mockCtx.waitUntil.mock.results[0].value;

      const deleted = await store.delete("test-key");

      expect(deleted).toBe(true);

      const result = await store.get("test-key");
      expect(result).toBeNull();
    });

    it("should return false for non-existent entry", async () => {
      const store = new CFCacheStore({ ctx: createMockCtx() });
      const deleted = await store.delete("missing-key");
      expect(deleted).toBe(false);
    });
  });

  describe("key encoding", () => {
    it("should handle special characters in keys", async () => {
      const mockCtx = createMockCtx();
      const store = new CFCacheStore({ ctx: mockCtx });
      const data = createTestData();

      const key = "route:products/category=electronics&page=1";
      await store.set(key, data, 60);
      await mockCtx.waitUntil.mock.results[0].value;

      const result = await store.get(key);
      expect(result).not.toBeNull();
      expect(result!.data).toEqual(data);
    });
  });

  describe("baseUrl configuration", () => {
    it("should use explicit baseUrl when provided", async () => {
      const mockCtx = createMockCtx();
      const store = new CFCacheStore({
        ctx: mockCtx,
        baseUrl: "https://custom.example.com/",
      });
      const data = createTestData();

      await store.set("custom-key", data, 60);
      await mockCtx.waitUntil.mock.results[0].value;

      // Verify round-trip works with custom baseUrl
      const result = await store.get("custom-key");
      expect(result).not.toBeNull();
      expect(result!.data).toEqual(data);
    });

    it("should use fallback when no requestContext available", async () => {
      // Default behavior when getRequestContext returns null
      const mockCtx = createMockCtx();
      const store = new CFCacheStore({ ctx: mockCtx });
      const data = createTestData();

      await store.set("fallback-key", data, 60);
      await mockCtx.waitUntil.mock.results[0].value;

      // Verify round-trip works with fallback baseUrl
      const result = await store.get("fallback-key");
      expect(result).not.toBeNull();
      expect(result!.data).toEqual(data);
    });

    it("should resolve the request host lazily for a production domain", async () => {
      // Regression: the store is constructed before the per-request context
      // ALS is entered (the cache factory runs ahead of runWithRequestContext
      // in the handler), so deriving the host eagerly in the constructor always
      // missed the request and produced the internal fallback host even in
      // production. The base URL must be resolved per operation, inside the
      // request context, so a real domain becomes the Cache API key host.
      const mockCtx = createMockCtx();
      const store = new CFCacheStore({ ctx: mockCtx });
      const data = createTestData();

      const requestCtx = {
        request: new Request("https://shop.acme.com/products"),
      } as any;

      await runWithRequestContext(requestCtx, async () => {
        await store.set("prod-key", data, 60);
      });
      await mockCtx.waitUntil.mock.results[0].value;

      const keys = [...(mockCaches.default as any).store.keys()] as string[];
      expect(keys.length).toBeGreaterThan(0);
      expect(keys.every((k) => k.startsWith("https://shop.acme.com/"))).toBe(
        true,
      );
      expect(keys.some((k) => k.includes("rsc-dummy-host-1.com"))).toBe(false);
    });

    it("should use the internal fallback host on *.workers.dev preview", async () => {
      const mockCtx = createMockCtx();
      const store = new CFCacheStore({ ctx: mockCtx });
      const data = createTestData();

      const requestCtx = {
        request: new Request("https://preview.my-app.workers.dev/products"),
      } as any;

      await runWithRequestContext(requestCtx, async () => {
        await store.set("preview-key", data, 60);
      });
      await mockCtx.waitUntil.mock.results[0].value;

      const keys = [...(mockCaches.default as any).store.keys()] as string[];
      expect(keys.length).toBeGreaterThan(0);
      expect(
        keys.every((k) => k.startsWith("https://rsc-dummy-host-1.com/")),
      ).toBe(true);
    });
  });

  // ==========================================================================
  // Function Cache Methods (getItem / setItem)
  // ==========================================================================

  describe("getItem/setItem", () => {
    it("should return null for missing key", async () => {
      const store = new CFCacheStore({ ctx: createMockCtx() });
      const result = await store.getItem("missing");
      expect(result).toBeNull();
    });

    it("should store and retrieve a value", async () => {
      const mockCtx = createMockCtx();
      const store = new CFCacheStore({ ctx: mockCtx });

      await store.setItem("fn-key", "serialized-value", { ttl: 60 });
      await mockCtx.waitUntil.mock.results[0].value;

      const result = await store.getItem("fn-key");
      expect(result).not.toBeNull();
      expect(result!.value).toBe("serialized-value");
      expect(result!.shouldRevalidate).toBe(false);
    });

    it("should persist the encoded handle string losslessly alongside value", async () => {
      const mockCtx = createMockCtx();
      const store = new CFCacheStore({ ctx: mockCtx });

      await store.setItem("fn-handles", "value", {
        ttl: 60,
        handles: ENCODED_HANDLES,
      });
      await mockCtx.waitUntil.mock.results[0].value;

      const result = await store.getItem("fn-handles");
      // The encoded blob must survive the JSON-serializing L1 path byte-for-byte
      // (a raw Record with a Promise/ReactNode value would not).
      expect(result!.handles).toBe(ENCODED_HANDLES);
    });

    it("should set Cache-Control with TTL + SWR", async () => {
      const mockCtx = createMockCtx();
      const store = new CFCacheStore({ ctx: mockCtx });

      await store.setItem("fn-ttl", "value", { ttl: 60, swr: 300 });
      await mockCtx.waitUntil.mock.results[0].value;

      const cache = mockCaches.default;
      const request = new Request(
        "https://rsc-dummy-host-1.com/" + encodeURIComponent("fn:fn-ttl"),
      );
      const response = await cache.match(request);

      expect(response?.headers.get("Cache-Control")).toBe(
        "public, max-age=360",
      );
    });

    it("should use store defaults for TTL and SWR", async () => {
      const mockCtx = createMockCtx();
      const store = new CFCacheStore({
        ctx: mockCtx,
        defaults: { ttl: 120, swr: 600 },
      });

      await store.setItem("fn-defaults", "value");
      await mockCtx.waitUntil.mock.results[0].value;

      const cache = mockCaches.default;
      const request = new Request(
        "https://rsc-dummy-host-1.com/" + encodeURIComponent("fn:fn-defaults"),
      );
      const response = await cache.match(request);

      // TTL 120 + SWR 600 = 720
      expect(response?.headers.get("Cache-Control")).toBe(
        "public, max-age=720",
      );
    });

    it("should return shouldRevalidate=true for stale items", async () => {
      vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));

      const mockCtx = createMockCtx();
      const store = new CFCacheStore({ ctx: mockCtx });

      await store.setItem("fn-stale", "stale-value", { ttl: 60, swr: 300 });
      await mockCtx.waitUntil.mock.results[0].value;

      // Past TTL, within SWR window
      vi.advanceTimersByTime(120 * 1000);

      const result = await store.getItem("fn-stale");
      expect(result!.shouldRevalidate).toBe(true);
      expect(result!.value).toBe("stale-value");
    });

    it("should atomically mark REVALIDATING to prevent thundering herd", async () => {
      vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));

      const mockCtx = createMockCtx();
      const store = new CFCacheStore({ ctx: mockCtx });

      await store.setItem("fn-herd", "value", { ttl: 60, swr: 300 });
      await mockCtx.waitUntil.mock.results[0].value;

      vi.advanceTimersByTime(120 * 1000);

      // First get triggers revalidation
      const result1 = await store.getItem("fn-herd");
      expect(result1!.shouldRevalidate).toBe(true);

      // Second get sees REVALIDATING status
      const result2 = await store.getItem("fn-herd");
      expect(result2!.shouldRevalidate).toBe(false);
    });

    // Stamp the stored REVALIDATING entry with an `Age` header to model a
    // background revalidation that started but never completed.
    const stampAge = async (key: string, age: number) => {
      const reqUrl =
        "https://rsc-dummy-host-1.com/" + encodeURIComponent(`fn:${key}`);
      const stored = await mockCaches.default.match(new Request(reqUrl));
      const stamped = new Response(stored!.body, {
        status: stored!.status,
        headers: new Headers(stored!.headers),
      });
      stamped.headers.set("age", String(age));
      await mockCaches.default.put(new Request(reqUrl), stamped);
    };

    it("re-triggers revalidation when a REVALIDATING entry reaches MAX_REVALIDATION_INTERVAL", async () => {
      vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));

      const mockCtx = createMockCtx();
      const store = new CFCacheStore({ ctx: mockCtx });

      await store.setItem("fn-stuck", "value", { ttl: 60, swr: 300 });
      await mockCtx.waitUntil.mock.results[0].value;

      vi.advanceTimersByTime(120 * 1000); // past ttl, within swr

      // First get marks REVALIDATING. A healthy background revalidation would
      // refresh the entry; simulate a hung one by leaving it REVALIDATING.
      expect((await store.getItem("fn-stuck"))!.shouldRevalidate).toBe(true);
      // Recent REVALIDATING (age 0 < interval): guarded, no re-trigger.
      expect((await store.getItem("fn-stuck"))!.shouldRevalidate).toBe(false);

      // age === interval: the guard expires and the next get re-triggers, so a
      // dropped revalidation can never pin the entry stale forever.
      await stampAge("fn-stuck", MAX_REVALIDATION_INTERVAL);
      expect((await store.getItem("fn-stuck"))!.shouldRevalidate).toBe(true);
    });

    it("does not re-trigger one second before MAX_REVALIDATION_INTERVAL", async () => {
      vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));

      const mockCtx = createMockCtx();
      const store = new CFCacheStore({ ctx: mockCtx });

      await store.setItem("fn-edge", "value", { ttl: 60, swr: 300 });
      await mockCtx.waitUntil.mock.results[0].value;

      vi.advanceTimersByTime(120 * 1000);

      expect((await store.getItem("fn-edge"))!.shouldRevalidate).toBe(true);

      // age === interval - 1: still within the guard window (`age < interval`).
      await stampAge("fn-edge", MAX_REVALIDATION_INTERVAL - 1);
      expect((await store.getItem("fn-edge"))!.shouldRevalidate).toBe(false);
    });

    it("should return shouldRevalidate=false for fresh items", async () => {
      vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));

      const mockCtx = createMockCtx();
      const store = new CFCacheStore({ ctx: mockCtx });

      await store.setItem("fn-fresh", "fresh-value", { ttl: 60, swr: 300 });
      await mockCtx.waitUntil.mock.results[0].value;

      vi.advanceTimersByTime(30 * 1000);

      const result = await store.getItem("fn-fresh");
      expect(result!.shouldRevalidate).toBe(false);
    });

    it("should use fn: prefix in cache key", async () => {
      const mockCtx = createMockCtx();
      const store = new CFCacheStore({ ctx: mockCtx });

      await store.setItem("my-key", "value", { ttl: 60 });
      await mockCtx.waitUntil.mock.results[0].value;

      // Verify fn: prefix is used
      const cache = mockCaches.default;
      const request = new Request(
        "https://rsc-dummy-host-1.com/" + encodeURIComponent("fn:my-key"),
      );
      const response = await cache.match(request);
      expect(response).toBeDefined();
    });

    it("should use waitUntil for non-blocking writes", async () => {
      const mockCtx = createMockCtx();
      const store = new CFCacheStore({ ctx: mockCtx });

      await store.setItem("fn-async", "value", { ttl: 60 });

      expect(mockCtx.waitUntil).toHaveBeenCalledTimes(1);
      expect(mockCtx.waitUntil).toHaveBeenCalledWith(expect.any(Promise));
    });
  });

  // ==========================================================================
  // Document Cache Methods (getResponse / putResponse)
  // ==========================================================================

  describe("getResponse/putResponse", () => {
    it("should return null for missing key", async () => {
      const store = new CFCacheStore({ ctx: createMockCtx() });
      const result = await store.getResponse("missing");
      expect(result).toBeNull();
    });

    it("should store and retrieve a response", async () => {
      const mockCtx = createMockCtx();
      const store = new CFCacheStore({ ctx: mockCtx });

      const response = new Response("hello world", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      });

      await store.putResponse("page-key", response, 60);
      await mockCtx.waitUntil.mock.results[0].value;

      const result = await store.getResponse("page-key");
      expect(result).not.toBeNull();
      expect(result!.response.status).toBe(200);
      expect(await result!.response.text()).toBe("hello world");
    });

    it("should return shouldRevalidate=false for fresh responses", async () => {
      vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));

      const mockCtx = createMockCtx();
      const store = new CFCacheStore({ ctx: mockCtx });

      await store.putResponse("doc-fresh", new Response("fresh"), 60, 300);
      await mockCtx.waitUntil.mock.results[0].value;

      vi.advanceTimersByTime(30 * 1000);
      const result = await store.getResponse("doc-fresh");
      expect(result!.shouldRevalidate).toBe(false);
    });

    it("should return shouldRevalidate=true for stale responses", async () => {
      vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));

      const mockCtx = createMockCtx();
      const store = new CFCacheStore({ ctx: mockCtx });

      await store.putResponse("doc-stale", new Response("stale"), 60, 300);
      await mockCtx.waitUntil.mock.results[0].value;

      // Past TTL, within SWR
      vi.advanceTimersByTime(120 * 1000);
      const result = await store.getResponse("doc-stale");
      expect(result!.shouldRevalidate).toBe(true);
      expect(await result!.response.text()).toBe("stale");
    });

    it("should set Cache-Control with TTL + SWR", async () => {
      const mockCtx = createMockCtx();
      const store = new CFCacheStore({ ctx: mockCtx });

      await store.putResponse("doc-cc", new Response("body"), 60, 300);
      await mockCtx.waitUntil.mock.results[0].value;

      const cache = mockCaches.default;
      const request = new Request(
        "https://rsc-dummy-host-1.com/" + encodeURIComponent("doc:doc-cc"),
      );
      const response = await cache.match(request);

      expect(response?.headers.get("Cache-Control")).toBe(
        "public, max-age=360",
      );
    });

    it("should use store defaults for SWR", async () => {
      vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));

      const mockCtx = createMockCtx();
      const store = new CFCacheStore({ ctx: mockCtx, defaults: { swr: 120 } });

      await store.putResponse("doc-default", new Response("body"), 60);
      await mockCtx.waitUntil.mock.results[0].value;

      // Past TTL, within default SWR
      vi.advanceTimersByTime(90 * 1000);
      const result = await store.getResponse("doc-default");
      expect(result!.shouldRevalidate).toBe(true);
    });

    it("should use doc: prefix in cache key", async () => {
      const mockCtx = createMockCtx();
      const store = new CFCacheStore({ ctx: mockCtx });

      await store.putResponse("my-doc", new Response("body"), 60);
      await mockCtx.waitUntil.mock.results[0].value;

      const cache = mockCaches.default;
      const request = new Request(
        "https://rsc-dummy-host-1.com/" + encodeURIComponent("doc:my-doc"),
      );
      const response = await cache.match(request);
      expect(response).toBeDefined();
    });

    it("should preserve response headers", async () => {
      const mockCtx = createMockCtx();
      const store = new CFCacheStore({ ctx: mockCtx });

      const response = new Response("body", {
        headers: {
          "Content-Type": "text/html",
          "X-Custom": "value",
        },
      });

      await store.putResponse("doc-headers", response, 60);
      await mockCtx.waitUntil.mock.results[0].value;

      const result = await store.getResponse("doc-headers");
      expect(result!.response.headers.get("X-Custom")).toBe("value");
    });

    it("should use waitUntil for non-blocking writes", async () => {
      const mockCtx = createMockCtx();
      const store = new CFCacheStore({ ctx: mockCtx });

      await store.putResponse("doc-async", new Response("body"), 60);

      expect(mockCtx.waitUntil).toHaveBeenCalledTimes(1);
      expect(mockCtx.waitUntil).toHaveBeenCalledWith(expect.any(Promise));
    });

    it("strips internal edge headers and restores the author's Cache-Control on serve", async () => {
      const mockCtx = createMockCtx();
      const store = new CFCacheStore({ ctx: mockCtx });

      const response = new Response("body", {
        headers: {
          "Content-Type": "text/html",
          "Cache-Control": "s-maxage=60, stale-while-revalidate=300",
          "X-Custom": "keep-me",
        },
      });

      await store.putResponse("doc-clean", response, 60, 300);
      await mockCtx.waitUntil.mock.results[0].value;

      const result = await store.getResponse("doc-clean");
      // Internal edge headers must never reach the client.
      expect(result!.response.headers.get(CACHE_STALE_AT_HEADER)).toBeNull();
      expect(result!.response.headers.get(CACHE_STATUS_HEADER)).toBeNull();
      expect(result!.response.headers.get("x-edge-cache-orig-cc")).toBeNull();
      // The author's Cache-Control is restored, not the internal edge max-age.
      expect(result!.response.headers.get("Cache-Control")).toBe(
        "s-maxage=60, stale-while-revalidate=300",
      );
      // Unrelated headers pass through untouched.
      expect(result!.response.headers.get("X-Custom")).toBe("keep-me");

      // The stored L1 entry keeps the long max-age so the CF Cache API retains
      // it across the whole SWR window.
      const stored = await mockCaches.default.match(
        new Request(
          "https://rsc-dummy-host-1.com/" + encodeURIComponent("doc:doc-clean"),
        ),
      );
      expect(stored?.headers.get("Cache-Control")).toBe("public, max-age=360");
    });

    it("drops the synthetic Cache-Control when the response carried none", async () => {
      const mockCtx = createMockCtx();
      const store = new CFCacheStore({ ctx: mockCtx });

      await store.putResponse("doc-nocc", new Response("body"), 60);
      await mockCtx.waitUntil.mock.results[0].value;

      const result = await store.getResponse("doc-nocc");
      expect(result!.response.headers.get("Cache-Control")).toBeNull();
      expect(result!.response.headers.get(CACHE_STALE_AT_HEADER)).toBeNull();
    });
  });

  // ==========================================================================
  // KV L2 Cache
  // ==========================================================================

  describe("KV L2 cache", () => {
    class MockKV {
      store = new Map<string, { value: string; expirationTtl?: number }>();

      async get(key: string, options?: { type?: string }): Promise<any> {
        const entry = this.store.get(key);
        if (!entry) return null;
        if (options?.type === "json") return JSON.parse(entry.value);
        return entry.value;
      }

      async put(
        key: string,
        value: string,
        options?: { expirationTtl?: number },
      ): Promise<void> {
        this.store.set(key, {
          value,
          expirationTtl: options?.expirationTtl,
        });
      }

      async delete(key: string): Promise<void> {
        this.store.delete(key);
      }

      clear(): void {
        this.store.clear();
      }
    }

    let mockKV: MockKV;

    beforeEach(() => {
      mockKV = new MockKV();
    });

    describe("segment cache (get/set)", () => {
      it("should write to KV on set()", async () => {
        const mockCtx = createMockCtx();
        const store = new CFCacheStore({ ctx: mockCtx, kv: mockKV as any });
        const data = createTestData();

        await store.set("seg-key", data, 60, 300);
        // Wait for all waitUntil calls (L1 write + KV write)
        for (const result of mockCtx.waitUntil.mock.results) {
          await result.value;
        }

        // KV should have the entry
        const kvEntry = mockKV.store.get("seg-key");
        expect(kvEntry).toBeDefined();
        const envelope = JSON.parse(kvEntry!.value);
        expect(envelope.d).toEqual(data);
        expect(envelope.s).toBeGreaterThan(0);
        expect(envelope.e).toBeGreaterThan(envelope.s);
        expect(kvEntry!.expirationTtl).toBe(360); // 60 + 300
      });

      it("should not write to KV when kv is not configured", async () => {
        const mockCtx = createMockCtx();
        const store = new CFCacheStore({ ctx: mockCtx });
        const data = createTestData();

        await store.set("seg-key", data, 60);
        for (const result of mockCtx.waitUntil.mock.results) {
          await result.value;
        }

        // Only 1 waitUntil call (L1 write), no KV write
        expect(mockCtx.waitUntil).toHaveBeenCalledTimes(1);
      });

      it("should fall back to KV on L1 miss", async () => {
        vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));

        const mockCtx = createMockCtx();
        const store = new CFCacheStore({ ctx: mockCtx, kv: mockKV as any });
        const data = createTestData();

        // Write to both L1 and KV
        await store.set("seg-key", data, 60, 300);
        for (const result of mockCtx.waitUntil.mock.results) {
          await result.value;
        }

        // Clear L1 to simulate cold colo
        mockCaches.clear();

        const result = await store.get("seg-key");
        expect(result).not.toBeNull();
        expect(result!.data).toEqual(data);
        expect(result!.shouldRevalidate).toBe(false);
      });

      it("should skip KV write when totalTtl < 60s", async () => {
        const mockCtx = createMockCtx();
        const store = new CFCacheStore({ ctx: mockCtx, kv: mockKV as any });
        const data = createTestData();

        // TTL 30s, no SWR → totalTtl = 30 < 60
        await store.set("short-ttl", data, 30);
        for (const result of mockCtx.waitUntil.mock.results) {
          await result.value;
        }

        // KV should NOT have the entry
        expect(mockKV.store.has("short-ttl")).toBe(false);

        // L1 should still have it
        const result = await store.get("short-ttl");
        expect(result).not.toBeNull();
      });

      it("should write to KV when totalTtl >= 60s", async () => {
        const mockCtx = createMockCtx();
        const store = new CFCacheStore({ ctx: mockCtx, kv: mockKV as any });
        const data = createTestData();

        await store.set("long-ttl", data, 60);
        for (const result of mockCtx.waitUntil.mock.results) {
          await result.value;
        }

        expect(mockKV.store.has("long-ttl")).toBe(true);
      });

      it("should return shouldRevalidate=true for stale KV entries", async () => {
        vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));

        const mockCtx = createMockCtx();
        const store = new CFCacheStore({ ctx: mockCtx, kv: mockKV as any });
        const data = createTestData();

        await store.set("seg-key", data, 60, 300);
        for (const result of mockCtx.waitUntil.mock.results) {
          await result.value;
        }

        // Clear L1 and advance past TTL but within SWR
        mockCaches.clear();
        vi.advanceTimersByTime(120 * 1000);

        const result = await store.get("seg-key");
        expect(result).not.toBeNull();
        expect(result!.data).toEqual(data);
        expect(result!.shouldRevalidate).toBe(true);
      });

      it("should return null for hard-expired KV entries", async () => {
        vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));

        const mockCtx = createMockCtx();
        const store = new CFCacheStore({ ctx: mockCtx, kv: mockKV as any });
        const data = createTestData();

        await store.set("seg-key", data, 60, 300);
        for (const result of mockCtx.waitUntil.mock.results) {
          await result.value;
        }

        // Clear L1 and advance past TTL + SWR
        mockCaches.clear();
        vi.advanceTimersByTime(400 * 1000);

        const result = await store.get("seg-key");
        expect(result).toBeNull();
      });

      it("should promote KV hit to L1", async () => {
        vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));

        const mockCtx = createMockCtx();
        const store = new CFCacheStore({ ctx: mockCtx, kv: mockKV as any });
        const data = createTestData();

        await store.set("seg-key", data, 60, 300);
        for (const result of mockCtx.waitUntil.mock.results) {
          await result.value;
        }

        // Clear L1
        mockCaches.clear();

        // Read from KV (promotes to L1)
        const kvResult = await store.get("seg-key");
        expect(kvResult).not.toBeNull();

        // Wait for promote waitUntil
        for (const result of mockCtx.waitUntil.mock.results) {
          await result.value;
        }

        // Clear KV to prove L1 has the entry now
        mockKV.clear();

        // Should now hit L1
        const l1Result = await store.get("seg-key");
        expect(l1Result).not.toBeNull();
        expect(l1Result!.data).toEqual(data);
      });

      it("should not check KV when L1 hits", async () => {
        const mockCtx = createMockCtx();
        const kvGetSpy = vi.spyOn(mockKV, "get");
        const store = new CFCacheStore({ ctx: mockCtx, kv: mockKV as any });
        const data = createTestData();

        await store.set("seg-key", data, 60);
        for (const result of mockCtx.waitUntil.mock.results) {
          await result.value;
        }

        await store.get("seg-key");
        // KV.get should not have been called (L1 hit)
        expect(kvGetSpy).not.toHaveBeenCalled();
      });

      it("should return null when both L1 and KV miss", async () => {
        const mockCtx = createMockCtx();
        const store = new CFCacheStore({ ctx: mockCtx, kv: mockKV as any });

        const result = await store.get("missing-key");
        expect(result).toBeNull();
      });
    });

    describe("function cache (getItem/setItem)", () => {
      it("should write to KV on setItem()", async () => {
        const mockCtx = createMockCtx();
        const store = new CFCacheStore({ ctx: mockCtx, kv: mockKV as any });

        await store.setItem("fn-key", "serialized-value", {
          ttl: 60,
          swr: 300,
          handles: ENCODED_HANDLES,
        });
        for (const result of mockCtx.waitUntil.mock.results) {
          await result.value;
        }

        const kvEntry = mockKV.store.get("fn:fn-key");
        expect(kvEntry).toBeDefined();
        const envelope = JSON.parse(kvEntry!.value);
        expect(envelope.v).toBe("serialized-value");
        // The KV envelope stores the encoded string verbatim (h field).
        expect(envelope.h).toBe(ENCODED_HANDLES);
      });

      it("should fall back to KV on L1 miss for getItem()", async () => {
        vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));

        const mockCtx = createMockCtx();
        const store = new CFCacheStore({ ctx: mockCtx, kv: mockKV as any });

        await store.setItem("fn-key", "my-value", { ttl: 60 });
        for (const result of mockCtx.waitUntil.mock.results) {
          await result.value;
        }

        mockCaches.clear();

        const result = await store.getItem("fn-key");
        expect(result).not.toBeNull();
        expect(result!.value).toBe("my-value");
        expect(result!.shouldRevalidate).toBe(false);
      });

      it("should return shouldRevalidate=true for stale KV function entries", async () => {
        vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));

        const mockCtx = createMockCtx();
        const store = new CFCacheStore({ ctx: mockCtx, kv: mockKV as any });

        await store.setItem("fn-key", "stale-value", { ttl: 60, swr: 300 });
        for (const result of mockCtx.waitUntil.mock.results) {
          await result.value;
        }

        mockCaches.clear();
        vi.advanceTimersByTime(120 * 1000);

        const result = await store.getItem("fn-key");
        expect(result).not.toBeNull();
        expect(result!.value).toBe("stale-value");
        expect(result!.shouldRevalidate).toBe(true);
      });

      it("should promote KV item hit to L1", async () => {
        vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));

        const mockCtx = createMockCtx();
        const store = new CFCacheStore({ ctx: mockCtx, kv: mockKV as any });

        await store.setItem("fn-key", "promote-value", { ttl: 60 });
        for (const result of mockCtx.waitUntil.mock.results) {
          await result.value;
        }

        mockCaches.clear();

        // Read from KV (triggers promote)
        await store.getItem("fn-key");
        for (const result of mockCtx.waitUntil.mock.results) {
          await result.value;
        }

        // Clear KV, L1 should have the promoted entry
        mockKV.clear();

        const l1Result = await store.getItem("fn-key");
        expect(l1Result).not.toBeNull();
        expect(l1Result!.value).toBe("promote-value");
      });
    });

    describe("document cache (getResponse/putResponse)", () => {
      it("should write to KV on putResponse()", async () => {
        const mockCtx = createMockCtx();
        const store = new CFCacheStore({ ctx: mockCtx, kv: mockKV as any });

        const response = new Response("hello world", {
          status: 200,
          headers: { "Content-Type": "text/html", "X-Custom": "value" },
        });

        await store.putResponse("doc-key", response, 60, 300);
        for (const result of mockCtx.waitUntil.mock.results) {
          await result.value;
        }

        const kvEntry = mockKV.store.get("doc:doc-key");
        expect(kvEntry).toBeDefined();
        const envelope = JSON.parse(kvEntry!.value);
        // Body is stored as base64
        expect(envelope.b).toBe(btoa("hello world"));
        expect(envelope.st).toBe(200);
        expect(envelope.hd).toEqual(
          expect.arrayContaining([
            ["content-type", "text/html"],
            ["x-custom", "value"],
          ]),
        );
      });

      it("should fall back to KV on L1 miss for getResponse()", async () => {
        vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));

        const mockCtx = createMockCtx();
        const store = new CFCacheStore({ ctx: mockCtx, kv: mockKV as any });

        await store.putResponse(
          "doc-key",
          new Response("cached html", {
            status: 200,
            headers: { "Content-Type": "text/html" },
          }),
          60,
          300,
        );
        for (const result of mockCtx.waitUntil.mock.results) {
          await result.value;
        }

        mockCaches.clear();

        const result = await store.getResponse("doc-key");
        expect(result).not.toBeNull();
        expect(result!.response.status).toBe(200);
        expect(await result!.response.text()).toBe("cached html");
        expect(result!.shouldRevalidate).toBe(false);
      });

      it("should preserve response headers from KV", async () => {
        vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));

        const mockCtx = createMockCtx();
        const store = new CFCacheStore({ ctx: mockCtx, kv: mockKV as any });

        await store.putResponse(
          "doc-headers",
          new Response("body", {
            headers: { "X-Custom": "preserved" },
          }),
          60,
        );
        for (const result of mockCtx.waitUntil.mock.results) {
          await result.value;
        }

        mockCaches.clear();

        const result = await store.getResponse("doc-headers");
        expect(result!.response.headers.get("X-Custom")).toBe("preserved");
      });

      it("should preserve binary body through KV round-trip", async () => {
        vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));

        const mockCtx = createMockCtx();
        const store = new CFCacheStore({ ctx: mockCtx, kv: mockKV as any });

        // Create binary payload with non-UTF8 bytes
        const binaryData = new Uint8Array([
          0x00, 0x01, 0x80, 0xff, 0xfe, 0x89, 0x50, 0x4e, 0x47,
        ]);
        const response = new Response(binaryData, {
          status: 200,
          headers: { "Content-Type": "image/png" },
        });

        await store.putResponse("binary-doc", response, 60, 300);
        for (const result of mockCtx.waitUntil.mock.results) {
          await result.value;
        }

        // Clear L1, read from KV
        mockCaches.clear();

        const result = await store.getResponse("binary-doc");
        expect(result).not.toBeNull();

        const roundTripped = new Uint8Array(
          await result!.response.arrayBuffer(),
        );
        expect(roundTripped).toEqual(binaryData);
        expect(result!.response.headers.get("Content-Type")).toBe("image/png");
      });

      it("should promote KV response hit to L1", async () => {
        vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));

        const mockCtx = createMockCtx();
        const store = new CFCacheStore({ ctx: mockCtx, kv: mockKV as any });

        await store.putResponse("doc-promote", new Response("promote me"), 60);
        for (const result of mockCtx.waitUntil.mock.results) {
          await result.value;
        }

        mockCaches.clear();

        // Read from KV (triggers promote)
        await store.getResponse("doc-promote");
        for (const result of mockCtx.waitUntil.mock.results) {
          await result.value;
        }

        // Clear KV, L1 should have the promoted entry
        mockKV.clear();

        const l1Result = await store.getResponse("doc-promote");
        expect(l1Result).not.toBeNull();
        expect(await l1Result!.response.text()).toBe("promote me");
      });
    });

    describe("delete", () => {
      it("should delete from both L1 and KV", async () => {
        const mockCtx = createMockCtx();
        const store = new CFCacheStore({ ctx: mockCtx, kv: mockKV as any });
        const data = createTestData();

        await store.set("del-key", data, 60);
        for (const result of mockCtx.waitUntil.mock.results) {
          await result.value;
        }

        expect(mockKV.store.has("del-key")).toBe(true);

        await store.delete("del-key");
        for (const result of mockCtx.waitUntil.mock.results) {
          await result.value;
        }

        expect(mockKV.store.has("del-key")).toBe(false);

        const result = await store.get("del-key");
        expect(result).toBeNull();
      });
    });

    describe("error handling", () => {
      it("should return null when KV read fails", async () => {
        const mockCtx = createMockCtx();
        const failingKV = {
          get: vi.fn().mockRejectedValue(new Error("KV unavailable")),
          put: vi.fn(),
          delete: vi.fn(),
        };
        const store = new CFCacheStore({
          ctx: mockCtx,
          kv: failingKV as any,
        });

        const result = await store.get("any-key");
        expect(result).toBeNull();
      });

      it("should not break set() when KV write fails", async () => {
        const mockCtx = createMockCtx();
        const failingKV = {
          get: vi.fn(),
          put: vi.fn().mockRejectedValue(new Error("KV write failed")),
          delete: vi.fn(),
        };
        const store = new CFCacheStore({
          ctx: mockCtx,
          kv: failingKV as any,
        });
        const data = createTestData();

        // Should not throw
        await store.set("seg-key", data, 60);
        for (const result of mockCtx.waitUntil.mock.results) {
          // KV waitUntil will fail but shouldn't propagate
          await result.value.catch(() => {});
        }

        // L1 should still have the data
        const result = await store.get("seg-key");
        expect(result).not.toBeNull();
      });
    });
  });
});
