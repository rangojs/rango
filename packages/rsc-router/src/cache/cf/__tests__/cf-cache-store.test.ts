import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  CFCacheStore,
  CACHE_STALE_AT_HEADER,
  CACHE_STATUS_HEADER,
} from "../cf-cache-store";
import type { CachedEntryData } from "../../types";

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
  handles: {},
  expiresAt: Date.now() + 60000,
});

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
        "[CFCacheStore] ExecutionContext (ctx) is required"
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
      const request = new Request("https://rsc-cache.internal.com/test-key");
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
      const request = new Request("https://rsc-cache.internal.com/test-key");
      const response = await cache.match(request);

      expect(response?.headers.get("Cache-Control")).toBe("public, max-age=360");
    });

    it("should use store defaults for SWR if not provided", async () => {
      const mockCtx = createMockCtx();
      const store = new CFCacheStore({ ctx: mockCtx, defaults: { swr: 120 } });
      const data = createTestData();

      await store.set("test-key", data, 60);
      await mockCtx.waitUntil.mock.results[0].value;

      const cache = mockCaches.default;
      const request = new Request("https://rsc-cache.internal.com/test-key");
      const response = await cache.match(request);

      expect(response?.headers.get("Cache-Control")).toBe("public, max-age=180");
    });

    it("should use named cache when namespace is provided", async () => {
      const mockCtx = createMockCtx();
      const store = new CFCacheStore({ ctx: mockCtx, namespace: "custom-cache" });
      const data = createTestData();

      await store.set("test-key", data, 60);
      await mockCtx.waitUntil.mock.results[0].value;

      const cache = await mockCaches.open("custom-cache");
      const request = new Request("https://rsc-cache.internal.com/test-key");
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
      const request = new Request("https://rsc-cache.internal.com/test-key");
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
      const request = new Request("https://rsc-cache.internal.com/test-key");
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
        "https://rsc-cache.internal.com/" + encodeURIComponent("test-key")
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
});
