import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  CFCacheStore,
  CACHE_STALE_AT_HEADER,
  CACHE_STATUS_HEADER,
  CACHE_REVALIDATING_AT_HEADER,
  MAX_REVALIDATION_INTERVAL,
  EDGE_LOOKUP_TIMEOUT_MS,
  EDGE_READ_TIMEOUT_MS,
  KV_READ_TIMEOUT_MS,
  type CFCacheReadDebugEvent,
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
    // Restore any spies a prior test left active. Tests restore inline at their
    // end, but an inline restore is skipped when an assertion throws first, so a
    // failing test could otherwise leak a `match`/`console` spy into the next.
    vi.restoreAllMocks();
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
      // The guarded read is served from the re-serialized REVALIDATING re-put;
      // pin that the round-trip preserved the payload byte-for-byte.
      expect(result2?.data).toEqual(data);
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
      expect(result1?.data).toEqual(data);

      // Subsequent requests see REVALIDATING status and are served from the
      // re-serialized re-put; assert the data survives the round-trip.
      const result2 = await store.get("test-key");
      expect(result2?.shouldRevalidate).toBe(false);
      expect(result2?.data).toEqual(data);

      const result3 = await store.get("test-key");
      expect(result3?.shouldRevalidate).toBe(false);
      expect(result3?.data).toEqual(data);
    });

    it("returns the stale data even when the REVALIDATING marker write fails (segment get)", async () => {
      vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));
      const mockCtx = createMockCtx();
      const store = new CFCacheStore({ ctx: mockCtx });
      const data = createTestData();

      await store.set("marker-fail", data, 60, 300);
      await mockCtx.waitUntil.mock.results[0].value;

      // Stale, and the (now non-blocking, best-effort) marker put rejects.
      vi.advanceTimersByTime(120 * 1000);
      const putSpy = vi
        .spyOn(mockCaches.default, "put")
        .mockRejectedValue(new Error("cache.put boom"));

      const result = await store.get("marker-fail");

      // A failed marker write must not turn a good stale read into a null/miss.
      expect(result).not.toBeNull();
      expect(result!.data).toEqual(data);
      expect(result!.shouldRevalidate).toBe(true);
      expect(putSpy).toHaveBeenCalled();

      putSpy.mockRestore();
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

  describe("edge cache lookup timeout", () => {
    it("treats an L1 lookup exceeding the budget as a miss and warns", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      // match never resolves -> the latency budget must win and report a miss
      const matchSpy = vi
        .spyOn(mockCaches.default, "match")
        .mockImplementation(() => new Promise<Response>(() => {}));

      const store = new CFCacheStore({ ctx: createMockCtx() });
      const resultPromise = store.get("slow-key");
      await vi.advanceTimersByTimeAsync(EDGE_LOOKUP_TIMEOUT_MS);
      const result = await resultPromise;

      // No KV configured -> "not hit" resolves to a full miss.
      expect(result).toBeNull();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining(`exceeded ${EDGE_LOOKUP_TIMEOUT_MS}ms`),
      );

      matchSpy.mockRestore();
      warnSpy.mockRestore();
    });

    it("does not warn when the L1 lookup resolves within the budget", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const mockCtx = createMockCtx();
      const store = new CFCacheStore({ ctx: mockCtx });
      const data = createTestData();

      await store.set("fast-key", data, 60);
      await mockCtx.waitUntil.mock.results[0].value;

      const result = await store.get("fast-key");

      expect(result).not.toBeNull();
      expect(result!.data).toEqual(data);
      expect(warnSpy).not.toHaveBeenCalled();

      warnSpy.mockRestore();
    });

    it("honors a custom edgeLookupTimeoutMs budget", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const matchSpy = vi
        .spyOn(mockCaches.default, "match")
        .mockImplementation(() => new Promise<Response>(() => {}));

      const store = new CFCacheStore({
        ctx: createMockCtx(),
        edgeLookupTimeoutMs: 50,
      });
      const resultPromise = store.get("slow-key");

      // At the default budget (10ms) the custom 50ms budget has not fired.
      await vi.advanceTimersByTimeAsync(10);
      expect(warnSpy).not.toHaveBeenCalled();

      // At 50ms it does, and the warning reports the configured budget.
      await vi.advanceTimersByTimeAsync(40);
      const result = await resultPromise;

      expect(result).toBeNull();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("exceeded 50ms"),
      );

      matchSpy.mockRestore();
      warnSpy.mockRestore();
    });

    it("disables the budget when edgeLookupTimeoutMs <= 0", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const matchSpy = vi
        .spyOn(mockCaches.default, "match")
        .mockImplementation(() => new Promise<Response>(() => {}));

      const store = new CFCacheStore({
        ctx: createMockCtx(),
        edgeLookupTimeoutMs: 0,
      });
      let settled = false;
      void store.get("hang-key").then(() => {
        settled = true;
      });

      // Well past any default budget: a disabled budget never abandons the
      // match, so the read stays pending and nothing is warned.
      await vi.advanceTimersByTimeAsync(1000);

      expect(settled).toBe(false);
      expect(warnSpy).not.toHaveBeenCalled();

      matchSpy.mockRestore();
      warnSpy.mockRestore();
    });
  });

  describe("edge cache body read timeout and status guard", () => {
    // Build a fake matched Response. CF resolves match() with a lazily-streamed
    // body, so we model a body that never settles (hangBody) to exercise the
    // post-match read budget independently of the match budget.
    const fakeMatched = (
      status: number,
      opts: { hangBody?: boolean; headers?: Record<string, string> } = {},
    ): Response =>
      ({
        status,
        headers: new Headers({
          [CACHE_STATUS_HEADER]: "HIT",
          ...(opts.headers ?? {}),
        }),
        json: opts.hangBody
          ? () => new Promise(() => {})
          : async () => createTestData(),
      }) as unknown as Response;

    it("treats a slow L1 body read as a miss and warns (segment get)", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      // match resolves fast, but the body never settles -> the read budget wins.
      const matchSpy = vi
        .spyOn(mockCaches.default, "match")
        .mockResolvedValue(fakeMatched(200, { hangBody: true }));

      const store = new CFCacheStore({ ctx: createMockCtx() });
      const resultPromise = store.get("slow-body");
      await vi.advanceTimersByTimeAsync(EDGE_READ_TIMEOUT_MS);
      const result = await resultPromise;

      // No KV configured -> body timeout resolves to a full miss.
      expect(result).toBeNull();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining(`body read exceeded ${EDGE_READ_TIMEOUT_MS}ms`),
      );

      matchSpy.mockRestore();
      warnSpy.mockRestore();
    });

    it("treats a slow L1 body read as a miss and warns (function getItem)", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const matchSpy = vi
        .spyOn(mockCaches.default, "match")
        .mockResolvedValue(fakeMatched(200, { hangBody: true }));

      const store = new CFCacheStore({ ctx: createMockCtx() });
      const resultPromise = store.getItem("slow-body-fn");
      await vi.advanceTimersByTimeAsync(EDGE_READ_TIMEOUT_MS);
      const result = await resultPromise;

      expect(result).toBeNull();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining(`body read exceeded ${EDGE_READ_TIMEOUT_MS}ms`),
      );

      matchSpy.mockRestore();
      warnSpy.mockRestore();
    });

    it("honors a custom edgeReadTimeoutMs budget", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const matchSpy = vi
        .spyOn(mockCaches.default, "match")
        .mockResolvedValue(fakeMatched(200, { hangBody: true }));

      const store = new CFCacheStore({
        ctx: createMockCtx(),
        edgeReadTimeoutMs: 50,
      });
      const resultPromise = store.get("slow-body");

      // The configured 50ms budget fires (and overrides the lower default).
      await vi.advanceTimersByTimeAsync(50);
      const result = await resultPromise;

      expect(result).toBeNull();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("body read exceeded 50ms"),
      );

      matchSpy.mockRestore();
      warnSpy.mockRestore();
    });

    it("disables the body budget when edgeReadTimeoutMs <= 0", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const matchSpy = vi
        .spyOn(mockCaches.default, "match")
        .mockResolvedValue(fakeMatched(200, { hangBody: true }));

      const store = new CFCacheStore({
        ctx: createMockCtx(),
        edgeReadTimeoutMs: 0,
      });
      let settled = false;
      void store.get("hang-body").then(() => {
        settled = true;
      });

      // A disabled budget never abandons the body read; it stays pending.
      await vi.advanceTimersByTimeAsync(1000);

      expect(settled).toBe(false);
      expect(warnSpy).not.toHaveBeenCalled();

      matchSpy.mockRestore();
      warnSpy.mockRestore();
    });

    it("treats a non-200 L1 entry as a miss (segment get)", async () => {
      const events: CFCacheReadDebugEvent[] = [];
      const matchSpy = vi
        .spyOn(mockCaches.default, "match")
        .mockResolvedValue(fakeMatched(500));

      const store = new CFCacheStore({
        ctx: createMockCtx(),
        debug: (e) => events.push(e),
      });
      const result = await store.get("err-entry");

      // A cached error/foreign response must not be parsed and served as a hit.
      expect(result).toBeNull();
      expect(events.at(-1)).toMatchObject({
        op: "get",
        outcome: "non-200",
        status: 500,
      });

      matchSpy.mockRestore();
    });

    it("treats a non-200 L1 entry as a miss (function getItem)", async () => {
      const matchSpy = vi
        .spyOn(mockCaches.default, "match")
        .mockResolvedValue(fakeMatched(500));

      const store = new CFCacheStore({ ctx: createMockCtx() });
      const result = await store.getItem("err-fn");

      expect(result).toBeNull();

      matchSpy.mockRestore();
    });

    it("emits a debug event describing a fresh L1 hit", async () => {
      const events: CFCacheReadDebugEvent[] = [];
      const mockCtx = createMockCtx();
      const store = new CFCacheStore({
        ctx: mockCtx,
        debug: (e) => events.push(e),
      });
      const data = createTestData();

      await store.set("dbg", data, 60);
      await mockCtx.waitUntil.mock.results[0].value;

      const result = await store.get("dbg");
      expect(result!.data).toEqual(data);

      const fresh = events.find((e) => e.op === "get" && e.key === "dbg");
      expect(fresh).toMatchObject({
        outcome: "l1-fresh",
        status: 200,
        // The stored cache status is surfaced raw (HIT here), distinct from the
        // computed isRevalidating, so an operator can tell HIT from a
        // REVALIDATING entry whose stamp aged out.
        cacheStatus: "HIT",
        shouldRevalidate: false,
      });
    });

    // Regression guard for the stale-path read-before-put fix. A stale entry
    // whose body never settles must time out to a miss WITHOUT writing the
    // REVALIDATING marker first. Modeled with a real ReadableStream body so the
    // pre-fix path (response.body.tee() + a blocking cache.put before the read
    // budget) is actually exercised: on a real stalled CF stream that put blocks
    // the request indefinitely, defeating edgeReadTimeoutMs. The fix reads the
    // body under budget first and skips the marker entirely on timeout.
    it("does not write the REVALIDATING marker when a stale L1 body read times out (segment get)", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const staleHungResponse = () =>
        new Response(
          new ReadableStream({
            start() {
              // never enqueue, never close -> the body read hangs
            },
          }),
          {
            status: 200,
            headers: {
              [CACHE_STATUS_HEADER]: "HIT",
              // Stale: staleAt is in the past relative to the fake clock.
              [CACHE_STALE_AT_HEADER]: String(Date.now() - 1000),
            },
          },
        );
      const matchSpy = vi
        .spyOn(mockCaches.default, "match")
        .mockResolvedValue(staleHungResponse());
      const putSpy = vi.spyOn(mockCaches.default, "put");

      const store = new CFCacheStore({ ctx: createMockCtx() });
      const resultPromise = store.get("stale-hung");
      await vi.advanceTimersByTimeAsync(EDGE_READ_TIMEOUT_MS);
      const result = await resultPromise;

      expect(result).toBeNull();
      expect(putSpy).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining(`body read exceeded ${EDGE_READ_TIMEOUT_MS}ms`),
      );

      matchSpy.mockRestore();
      putSpy.mockRestore();
      warnSpy.mockRestore();
    });

    it("emits a match-timeout debug event when the L1 lookup exceeds its budget (segment get)", async () => {
      const events: CFCacheReadDebugEvent[] = [];
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const matchSpy = vi
        .spyOn(mockCaches.default, "match")
        .mockImplementation(() => new Promise<Response>(() => {}));

      const store = new CFCacheStore({
        ctx: createMockCtx(),
        debug: (e) => events.push(e),
      });
      const resultPromise = store.get("slow-match");
      await vi.advanceTimersByTimeAsync(EDGE_LOOKUP_TIMEOUT_MS);
      const result = await resultPromise;

      // An abandoned slow match is reported distinctly from a genuine miss.
      expect(result).toBeNull();
      expect(events.at(-1)).toMatchObject({
        op: "get",
        outcome: "match-timeout",
      });

      matchSpy.mockRestore();
      warnSpy.mockRestore();
    });

    it("emits an l1-miss debug event when no L1 entry exists (segment get)", async () => {
      const events: CFCacheReadDebugEvent[] = [];
      const store = new CFCacheStore({
        ctx: createMockCtx(),
        debug: (e) => events.push(e),
      });

      const result = await store.get("absent");

      // No entry and no KV -> a genuine miss, distinct from match-timeout.
      expect(result).toBeNull();
      expect(events.at(-1)).toMatchObject({ op: "get", outcome: "l1-miss" });
    });
  });

  describe("stale re-put retention (remaining-ttl)", () => {
    // Read the Cache-Control written by the most recent cache.put. The stale-path
    // REVALIDATING re-put must recompute a SHRINKING remaining max-age from the
    // stored hard-expiry deadline rather than copying set()'s original full-window
    // header; copying it restarts CF's retention clock on every re-arm so a
    // perpetually-failing revalidation would pin the entry past hard-expiry.
    const lastPutCacheControl = (putSpy: ReturnType<typeof vi.spyOn>): string =>
      (putSpy.mock.calls.at(-1)![1] as Response).headers.get("Cache-Control")!;
    const maxAgeOf = (cc: string): number =>
      Number(cc.replace("public, max-age=", ""));

    it("re-puts a shrinking remaining-ttl on each re-arm, never restarting retention (segment get)", async () => {
      vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));
      const mockCtx = createMockCtx();
      const store = new CFCacheStore({ ctx: mockCtx });

      // totalTtl = 360 (ttl 60 + swr 300); hard-expiry at t0 + 360s.
      await store.set("seg-stuck", createTestData(), 60, 300);
      await mockCtx.waitUntil.mock.results[0].value;

      // Spy AFTER set() so only the re-put writes are captured.
      const putSpy = vi.spyOn(mockCaches.default, "put");

      // t = 120s: stale, within SWR. First get re-puts the REVALIDATING marker.
      vi.advanceTimersByTime(120 * 1000);
      expect((await store.get("seg-stuck"))!.shouldRevalidate).toBe(true);
      // Remaining window = 360 - 120 = 240, NOT the original full-window 360.
      expect(lastPutCacheControl(putSpy)).toBe("public, max-age=240");

      // t = 150s: the guard lapses at MAX_REVALIDATION_INTERVAL, re-arm re-puts.
      vi.advanceTimersByTime(MAX_REVALIDATION_INTERVAL * 1000);
      expect((await store.get("seg-stuck"))!.shouldRevalidate).toBe(true);
      // Keeps shrinking (210), proving retention is not restarted to 360.
      expect(lastPutCacheControl(putSpy)).toBe("public, max-age=210");

      // At the hard-expiry boundary the remaining floors to 1, never resets.
      vi.advanceTimersByTime(210 * 1000); // t = 360s
      await store.get("seg-stuck");
      expect(maxAgeOf(lastPutCacheControl(putSpy))).toBeLessThanOrEqual(1);

      putSpy.mockRestore();
    });

    it("re-puts a shrinking remaining-ttl on each re-arm, never restarting retention (function getItem)", async () => {
      vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));
      const mockCtx = createMockCtx();
      const store = new CFCacheStore({ ctx: mockCtx });

      await store.setItem("fn-stuck", "value", { ttl: 60, swr: 300 });
      await mockCtx.waitUntil.mock.results[0].value;

      const putSpy = vi.spyOn(mockCaches.default, "put");

      vi.advanceTimersByTime(120 * 1000);
      expect((await store.getItem("fn-stuck"))!.shouldRevalidate).toBe(true);
      expect(lastPutCacheControl(putSpy)).toBe("public, max-age=240");

      vi.advanceTimersByTime(MAX_REVALIDATION_INTERVAL * 1000);
      expect((await store.getItem("fn-stuck"))!.shouldRevalidate).toBe(true);
      expect(lastPutCacheControl(putSpy)).toBe("public, max-age=210");

      vi.advanceTimersByTime(210 * 1000);
      await store.getItem("fn-stuck");
      expect(maxAgeOf(lastPutCacheControl(putSpy))).toBeLessThanOrEqual(1);

      putSpy.mockRestore();
    });

    it("carries the hard-expiry deadline through a KV->L1 promote so a later re-put shrinks correctly (segment)", async () => {
      vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));
      const mockCtx = createMockCtx();
      const data = createTestData();
      // KV holds a fresh entry; staleAt at t0+60s, hard-expiry at t0+360s.
      const kv = {
        get: vi.fn(async () => ({
          d: data,
          s: Date.parse("2024-01-01T00:00:00Z") + 60_000,
          e: Date.parse("2024-01-01T00:00:00Z") + 360_000,
        })),
        put: vi.fn(),
        delete: vi.fn(),
      };
      const store = new CFCacheStore({ ctx: mockCtx, kv: kv as any });

      // Cold L1: the read falls to KV and promotes to L1 (carrying the deadline).
      const result = await store.get("promoted");
      expect(result!.data).toEqual(data);
      // Drain the promote waitUntil so the L1 entry is written.
      for (const r of mockCtx.waitUntil.mock.results) await r.value;

      const putSpy = vi.spyOn(mockCaches.default, "put");

      // t = 120s: the promoted entry is now stale; its re-put must use the
      // remaining window derived from the carried deadline (240), not floor to 1.
      vi.advanceTimersByTime(120 * 1000);
      expect((await store.get("promoted"))!.shouldRevalidate).toBe(true);
      expect(lastPutCacheControl(putSpy)).toBe("public, max-age=240");

      putSpy.mockRestore();
    });
  });

  describe("L1 read failure degrades to L2 (not the error sink)", () => {
    const corruptBody200 = (): Response =>
      ({
        status: 200,
        headers: new Headers({ [CACHE_STATUS_HEADER]: "HIT" }),
        json: () =>
          Promise.reject(new SyntaxError("Unexpected token < in JSON")),
      }) as unknown as Response;

    const freshSegmentKV = (data: CachedEntryData) => ({
      get: vi.fn(async () => ({
        d: data,
        s: Date.now() + 60_000,
        e: Date.now() + 360_000,
      })),
      put: vi.fn(),
      delete: vi.fn(),
    });

    it("falls through to L2 with a body-error outcome when a 200 L1 body read fails fast (segment get)", async () => {
      const events: CFCacheReadDebugEvent[] = [];
      const kvData = createTestData();
      const kv = freshSegmentKV(kvData);
      const matchSpy = vi
        .spyOn(mockCaches.default, "match")
        .mockResolvedValue(corruptBody200());
      const store = new CFCacheStore({
        ctx: createMockCtx(),
        kv: kv as any,
        debug: (e) => events.push(e),
      });

      const result = await store.get("corrupt-seg");

      // A corrupt/foreign-200 L1 body degrades to L2 instead of a total miss.
      expect(result).not.toBeNull();
      expect(result!.data).toEqual(kvData);
      expect(kv.get).toHaveBeenCalled();
      // Distinct from a timeout and from the outer error sink.
      expect(events.map((e) => e.outcome)).toEqual(["body-error", "kv-fresh"]);

      matchSpy.mockRestore();
    });

    it("falls through to L2 with a body-error outcome when a 200 L1 body read fails fast (function getItem)", async () => {
      const events: CFCacheReadDebugEvent[] = [];
      const kv = {
        get: vi.fn(async () => ({
          v: "kv-value",
          s: Date.now() + 60_000,
          e: Date.now() + 360_000,
        })),
        put: vi.fn(),
        delete: vi.fn(),
      };
      const matchSpy = vi
        .spyOn(mockCaches.default, "match")
        .mockResolvedValue(corruptBody200());
      const store = new CFCacheStore({
        ctx: createMockCtx(),
        kv: kv as any,
        debug: (e) => events.push(e),
      });

      const result = await store.getItem("corrupt-fn");

      expect(result).not.toBeNull();
      expect(result!.value).toBe("kv-value");
      expect(kv.get).toHaveBeenCalled();
      expect(events.map((e) => e.outcome)).toEqual(["body-error", "kv-fresh"]);

      matchSpy.mockRestore();
    });

    it("falls through to L2 when cache.match rejects fast (segment get)", async () => {
      const kvData = createTestData();
      const kv = freshSegmentKV(kvData);
      const matchSpy = vi
        .spyOn(mockCaches.default, "match")
        .mockRejectedValue(new Error("match boom"));
      const store = new CFCacheStore({ ctx: createMockCtx(), kv: kv as any });

      const result = await store.get("match-fail-seg");

      // A fast match rejection is a miss that consults L2, not the outer catch.
      expect(result).not.toBeNull();
      expect(result!.data).toEqual(kvData);
      expect(kv.get).toHaveBeenCalled();

      matchSpy.mockRestore();
    });
  });

  describe("non-finite timeout budgets", () => {
    const hungBody200 = (): Response =>
      ({
        status: 200,
        headers: new Headers({ [CACHE_STATUS_HEADER]: "HIT" }),
        json: () => new Promise(() => {}),
      }) as unknown as Response;

    it("sanitizes a non-finite edgeReadTimeoutMs (NaN) to the default budget (segment get)", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const matchSpy = vi
        .spyOn(mockCaches.default, "match")
        .mockResolvedValue(hungBody200());
      // NaN slips past `?? DEFAULT`; unsanitized it coerces to a ~1ms timer
      // (warning "exceeded NaNms") and false-misses every read.
      const store = new CFCacheStore({
        ctx: createMockCtx(),
        edgeReadTimeoutMs: NaN,
      });

      const resultPromise = store.get("nan-budget");
      await vi.advanceTimersByTimeAsync(EDGE_READ_TIMEOUT_MS);
      const result = await resultPromise;

      expect(result).toBeNull();
      // The budget falls back to the default 20ms, not a coerced NaN.
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining(`body read exceeded ${EDGE_READ_TIMEOUT_MS}ms`),
      );
      expect(warnSpy).not.toHaveBeenCalledWith(
        expect.stringContaining("NaNms"),
      );

      matchSpy.mockRestore();
      warnSpy.mockRestore();
    });
  });

  describe("degraded fall-through herd mitigation", () => {
    // A stale L1 entry whose body never settles -> body-timeout -> degraded
    // fall-through to KV. KV has no REVALIDATING herd guard, so the store
    // suppresses revalidation on this path to avoid a render storm.
    const staleHungBody = (): Response =>
      ({
        status: 200,
        headers: new Headers({
          [CACHE_STATUS_HEADER]: "HIT",
          [CACHE_STALE_AT_HEADER]: String(Date.now() - 1000),
        }),
        json: () => new Promise(() => {}),
      }) as unknown as Response;

    const staleSegmentKV = (data: CachedEntryData) => ({
      get: vi.fn(async () => ({
        d: data,
        s: Date.now() - 1000, // stale
        e: Date.now() + 300_000, // not hard-expired
      })),
      put: vi.fn(),
      delete: vi.fn(),
    });

    it("suppresses revalidation on a body-timeout fall-through (segment get)", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const events: CFCacheReadDebugEvent[] = [];
      const kvData = createTestData();
      const matchSpy = vi
        .spyOn(mockCaches.default, "match")
        .mockResolvedValue(staleHungBody());
      const store = new CFCacheStore({
        ctx: createMockCtx(),
        kv: staleSegmentKV(kvData) as any,
        debug: (e) => events.push(e),
      });

      const resultPromise = store.get("degraded-seg");
      await vi.advanceTimersByTimeAsync(EDGE_READ_TIMEOUT_MS);
      const result = await resultPromise;

      // Stale KV data is served, but revalidation is withheld (no herd).
      expect(result!.data).toEqual(kvData);
      expect(result!.shouldRevalidate).toBe(false);
      expect(events.map((e) => e.outcome)).toEqual([
        "body-timeout",
        "kv-stale-suppressed",
      ]);

      matchSpy.mockRestore();
      warnSpy.mockRestore();
    });

    it("suppresses revalidation on a non-200 fall-through (segment get)", async () => {
      const events: CFCacheReadDebugEvent[] = [];
      const kvData = createTestData();
      const matchSpy = vi.spyOn(mockCaches.default, "match").mockResolvedValue({
        status: 500,
        headers: new Headers({ [CACHE_STATUS_HEADER]: "HIT" }),
        json: async () => ({}),
      } as unknown as Response);
      const store = new CFCacheStore({
        ctx: createMockCtx(),
        kv: staleSegmentKV(kvData) as any,
        debug: (e) => events.push(e),
      });

      const result = await store.get("non200-seg");

      expect(result!.data).toEqual(kvData);
      expect(result!.shouldRevalidate).toBe(false);
      expect(events.map((e) => e.outcome)).toEqual([
        "non-200",
        "kv-stale-suppressed",
      ]);

      matchSpy.mockRestore();
    });

    it("does NOT suppress revalidation on a genuine L1 miss (segment get)", async () => {
      const events: CFCacheReadDebugEvent[] = [];
      const kvData = createTestData();
      // No L1 entry -> genuine miss -> KV still gets its normal SWR signal.
      const store = new CFCacheStore({
        ctx: createMockCtx(),
        kv: staleSegmentKV(kvData) as any,
        debug: (e) => events.push(e),
      });

      const result = await store.get("missing-seg");

      expect(result!.data).toEqual(kvData);
      expect(result!.shouldRevalidate).toBe(true);
      expect(events.map((e) => e.outcome)).toEqual(["l1-miss", "kv-stale"]);
    });

    it("does NOT suppress revalidation on a body-error fall-through, so the corrupt entry can heal (segment get)", async () => {
      const events: CFCacheReadDebugEvent[] = [];
      const kvData = createTestData();
      const matchSpy = vi.spyOn(mockCaches.default, "match").mockResolvedValue({
        status: 200,
        headers: new Headers({
          [CACHE_STATUS_HEADER]: "HIT",
          [CACHE_STALE_AT_HEADER]: String(Date.now() - 1000),
        }),
        json: () => Promise.reject(new SyntaxError("corrupt")),
      } as unknown as Response);
      const store = new CFCacheStore({
        ctx: createMockCtx(),
        kv: staleSegmentKV(kvData) as any,
        debug: (e) => events.push(e),
      });

      const result = await store.get("corrupt-stale-seg");

      // A corrupt L1 body must still revalidate so a fresh render overwrites it.
      expect(result!.data).toEqual(kvData);
      expect(result!.shouldRevalidate).toBe(true);
      expect(events.map((e) => e.outcome)).toEqual(["body-error", "kv-stale"]);

      matchSpy.mockRestore();
    });

    it("suppresses revalidation on a body-timeout fall-through (function getItem)", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const events: CFCacheReadDebugEvent[] = [];
      const matchSpy = vi
        .spyOn(mockCaches.default, "match")
        .mockResolvedValue(staleHungBody());
      const kv = {
        get: vi.fn(async () => ({
          v: "kv-value",
          s: Date.now() - 1000,
          e: Date.now() + 300_000,
        })),
        put: vi.fn(),
        delete: vi.fn(),
      };
      const store = new CFCacheStore({
        ctx: createMockCtx(),
        kv: kv as any,
        debug: (e) => events.push(e),
      });

      const resultPromise = store.getItem("degraded-fn");
      await vi.advanceTimersByTimeAsync(EDGE_READ_TIMEOUT_MS);
      const result = await resultPromise;

      expect(result!.value).toBe("kv-value");
      expect(result!.shouldRevalidate).toBe(false);
      expect(events.map((e) => e.outcome)).toEqual([
        "body-timeout",
        "kv-stale-suppressed",
      ]);

      matchSpy.mockRestore();
      warnSpy.mockRestore();
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
      expect(result1!.value).toBe("value");

      // Second get sees REVALIDATING status and is served from the re-serialized
      // re-put; pin that value (and the handle blob) survive the round-trip.
      const result2 = await store.getItem("fn-herd");
      expect(result2!.shouldRevalidate).toBe(false);
      expect(result2!.value).toBe("value");
    });

    it("returns the stale value even when the REVALIDATING marker write fails (function getItem)", async () => {
      vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));
      const mockCtx = createMockCtx();
      const store = new CFCacheStore({ ctx: mockCtx });

      await store.setItem("fn-marker-fail", "value", { ttl: 60, swr: 300 });
      await mockCtx.waitUntil.mock.results[0].value;

      vi.advanceTimersByTime(120 * 1000);
      const putSpy = vi
        .spyOn(mockCaches.default, "put")
        .mockRejectedValue(new Error("cache.put boom"));

      const result = await store.getItem("fn-marker-fail");

      // A failed marker write must not turn a good stale read into a null/miss.
      expect(result).not.toBeNull();
      expect(result!.value).toBe("value");
      expect(result!.shouldRevalidate).toBe(true);
      expect(putSpy).toHaveBeenCalled();

      putSpy.mockRestore();
    });

    // Recency of a REVALIDATING entry is measured from the explicit
    // x-edge-cache-revalidating-at stamp the store writes when it marks the
    // entry, NOT CF's `Age` header. So we advance the clock (the stamp ages
    // with real time) instead of forging an `Age` header the store ignores.
    // This is the regression guard for the age-header unreliability fix: on the
    // old `Age`-based code the MockCache never set `Age`, so it defaulted to 0
    // and the re-arm below could never fire -- a dropped revalidation pinned
    // the entry stale until hard expiry.
    it("re-triggers revalidation when a REVALIDATING entry reaches MAX_REVALIDATION_INTERVAL", async () => {
      vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));

      const mockCtx = createMockCtx();
      const store = new CFCacheStore({ ctx: mockCtx });

      await store.setItem("fn-stuck", "value", { ttl: 60, swr: 300 });
      await mockCtx.waitUntil.mock.results[0].value;

      vi.advanceTimersByTime(120 * 1000); // past ttl, within swr

      // First get marks REVALIDATING (stamps revalidating-at = now). A healthy
      // background revalidation would refresh the entry; simulate a hung one by
      // leaving it REVALIDATING.
      expect((await store.getItem("fn-stuck"))!.shouldRevalidate).toBe(true);
      // Recent REVALIDATING (within interval): guarded, no re-trigger.
      expect((await store.getItem("fn-stuck"))!.shouldRevalidate).toBe(false);

      // Once the stamp ages to MAX_REVALIDATION_INTERVAL, the guard expires and
      // the next get re-triggers, so a dropped revalidation can never pin the
      // entry stale forever.
      vi.advanceTimersByTime(MAX_REVALIDATION_INTERVAL * 1000);
      expect((await store.getItem("fn-stuck"))!.shouldRevalidate).toBe(true);
    });

    it("does not re-trigger one second before MAX_REVALIDATION_INTERVAL", async () => {
      vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));

      const mockCtx = createMockCtx();
      const store = new CFCacheStore({ ctx: mockCtx });

      await store.setItem("fn-edge", "value", { ttl: 60, swr: 300 });
      await mockCtx.waitUntil.mock.results[0].value;

      vi.advanceTimersByTime(120 * 1000);

      // Marks REVALIDATING (stamps revalidating-at = now).
      expect((await store.getItem("fn-edge"))!.shouldRevalidate).toBe(true);

      // One second before the interval elapses: still within the guard window.
      vi.advanceTimersByTime((MAX_REVALIDATION_INTERVAL - 1) * 1000);
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

      it("emits a kv-fresh debug event on a fresh L2 fallback", async () => {
        vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));
        const events: CFCacheReadDebugEvent[] = [];
        const mockCtx = createMockCtx();
        const store = new CFCacheStore({
          ctx: mockCtx,
          kv: mockKV as any,
          debug: (e) => events.push(e),
        });
        const data = createTestData();

        await store.set("seg-fresh", data, 60, 300);
        for (const result of mockCtx.waitUntil.mock.results) {
          await result.value;
        }
        mockCaches.clear(); // cold colo -> L1 miss, fall to KV

        // Still within TTL: the KV entry is fresh.
        vi.advanceTimersByTime(30 * 1000);
        const result = await store.get("seg-fresh");

        expect(result!.shouldRevalidate).toBe(false);
        expect(events.at(-1)).toMatchObject({
          op: "get",
          outcome: "kv-fresh",
          shouldRevalidate: false,
        });
      });

      it("emits a kv-stale debug event on a stale L2 fallback", async () => {
        vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));
        const events: CFCacheReadDebugEvent[] = [];
        const mockCtx = createMockCtx();
        const store = new CFCacheStore({
          ctx: mockCtx,
          kv: mockKV as any,
          debug: (e) => events.push(e),
        });
        const data = createTestData();

        await store.set("seg-stale", data, 60, 300);
        for (const result of mockCtx.waitUntil.mock.results) {
          await result.value;
        }
        mockCaches.clear();

        // Past TTL but within SWR: the KV entry is stale and needs revalidation.
        vi.advanceTimersByTime(120 * 1000);
        const result = await store.get("seg-stale");

        expect(result!.shouldRevalidate).toBe(true);
        expect(events.at(-1)).toMatchObject({
          op: "get",
          outcome: "kv-stale",
          shouldRevalidate: true,
        });
      });

      it("emits a kv-miss debug event when neither tier has the entry", async () => {
        const events: CFCacheReadDebugEvent[] = [];
        const store = new CFCacheStore({
          ctx: createMockCtx(),
          kv: mockKV as any,
          debug: (e) => events.push(e),
        });

        const result = await store.get("nowhere");

        // L1 miss then L2 miss: both tiers reported, final outcome kv-miss.
        expect(result).toBeNull();
        expect(events.map((e) => e.outcome)).toEqual(["l1-miss", "kv-miss"]);
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

      it("emits kv-stale / kv-miss debug events for the L2 function path", async () => {
        vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));
        const events: CFCacheReadDebugEvent[] = [];
        const mockCtx = createMockCtx();
        const store = new CFCacheStore({
          ctx: mockCtx,
          kv: mockKV as any,
          debug: (e) => events.push(e),
        });

        await store.setItem("fn-dbg", "v", { ttl: 60, swr: 300 });
        for (const result of mockCtx.waitUntil.mock.results) {
          await result.value;
        }
        mockCaches.clear();
        vi.advanceTimersByTime(120 * 1000); // past TTL, within SWR

        await store.getItem("fn-dbg");
        expect(events.at(-1)).toMatchObject({
          op: "getItem",
          outcome: "kv-stale",
          shouldRevalidate: true,
        });

        events.length = 0;
        await store.getItem("fn-absent");
        expect(events.map((e) => e.outcome)).toEqual(["l1-miss", "kv-miss"]);
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

    describe("L2 read timeout (kvReadTimeoutMs)", () => {
      // A KV namespace whose get() never settles, to exercise the read budget.
      // (L1 is empty in these tests, so the read falls straight through to KV.)
      const hangingKV = () =>
        ({
          get: vi.fn(() => new Promise(() => {})),
          put: vi.fn(),
          delete: vi.fn(),
        }) as any;

      it("treats a slow KV read as a miss and warns, emitting kv-timeout (segment get)", async () => {
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
        const putSpy = vi.spyOn(mockCaches.default, "put");
        const events: CFCacheReadDebugEvent[] = [];
        const store = new CFCacheStore({
          ctx: createMockCtx(),
          kv: hangingKV(),
          debug: (e) => events.push(e),
        });

        const resultPromise = store.get("slow-kv");
        await vi.advanceTimersByTimeAsync(KV_READ_TIMEOUT_MS);
        const result = await resultPromise;

        expect(result).toBeNull();
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining(`KV read exceeded ${KV_READ_TIMEOUT_MS}ms`),
        );
        // L1 miss then a KV timeout, reported distinctly from a genuine kv-miss.
        expect(events.map((e) => e.outcome)).toEqual(["l1-miss", "kv-timeout"]);
        // No envelope on timeout -> no promote-to-L1 write.
        expect(putSpy).not.toHaveBeenCalled();

        putSpy.mockRestore();
        warnSpy.mockRestore();
      });

      it("routes a KV rejection to the error outcome, not kv-timeout/kv-miss (segment get)", async () => {
        const events: CFCacheReadDebugEvent[] = [];
        const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        const rejectingKV = {
          get: vi.fn().mockRejectedValue(new Error("KV unavailable")),
          put: vi.fn(),
          delete: vi.fn(),
        };
        const store = new CFCacheStore({
          ctx: createMockCtx(),
          kv: rejectingKV as any,
          debug: (e) => events.push(e),
        });

        const result = await store.get("err-kv");

        // A rejection is an error, NOT an abandoned-slow-read timeout nor a miss.
        expect(result).toBeNull();
        expect(events.map((e) => e.outcome)).toEqual(["l1-miss", "error"]);

        errSpy.mockRestore();
      });

      it("kvGetResponse stays debug-silent and returns null on KV rejection", async () => {
        const events: CFCacheReadDebugEvent[] = [];
        const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        const rejectingKV = {
          get: vi.fn().mockRejectedValue(new Error("KV unavailable")),
          put: vi.fn(),
          delete: vi.fn(),
        };
        const store = new CFCacheStore({
          ctx: createMockCtx(),
          kv: rejectingKV as any,
          debug: (e) => events.push(e),
        });

        const result = await store.getResponse("err-doc");

        // Document path emits no events on any failure (timeout or rejection).
        expect(result).toBeNull();
        expect(events).toEqual([]);

        errSpy.mockRestore();
      });

      it("treats a slow KV read as a miss and emits kv-timeout (function getItem)", async () => {
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
        const events: CFCacheReadDebugEvent[] = [];
        const store = new CFCacheStore({
          ctx: createMockCtx(),
          kv: hangingKV(),
          debug: (e) => events.push(e),
        });

        const resultPromise = store.getItem("slow-kv-fn");
        await vi.advanceTimersByTimeAsync(KV_READ_TIMEOUT_MS);
        const result = await resultPromise;

        expect(result).toBeNull();
        expect(events.map((e) => e.outcome)).toEqual(["l1-miss", "kv-timeout"]);
        expect(events.at(-1)).toMatchObject({ op: "getItem" });

        warnSpy.mockRestore();
      });

      it("bounds the document KV read but stays debug-silent (getResponse)", async () => {
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
        const events: CFCacheReadDebugEvent[] = [];
        const store = new CFCacheStore({
          ctx: createMockCtx(),
          kv: hangingKV(),
          debug: (e) => events.push(e),
        });

        const resultPromise = store.getResponse("slow-kv-doc");
        await vi.advanceTimersByTimeAsync(KV_READ_TIMEOUT_MS);
        const result = await resultPromise;

        // Bounded for resilience (warns), but the document path emits no events.
        expect(result).toBeNull();
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining(`KV read exceeded ${KV_READ_TIMEOUT_MS}ms`),
        );
        expect(events).toEqual([]);

        warnSpy.mockRestore();
      });

      it("honors a custom kvReadTimeoutMs budget", async () => {
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
        const store = new CFCacheStore({
          ctx: createMockCtx(),
          kv: hangingKV(),
          kvReadTimeoutMs: 200,
        });

        const resultPromise = store.get("slow-kv");
        await vi.advanceTimersByTimeAsync(200);
        const result = await resultPromise;

        expect(result).toBeNull();
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining("KV read exceeded 200ms"),
        );

        warnSpy.mockRestore();
      });

      it("disables the KV budget when kvReadTimeoutMs <= 0", async () => {
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
        const store = new CFCacheStore({
          ctx: createMockCtx(),
          kv: hangingKV(),
          kvReadTimeoutMs: 0,
        });

        let settled = false;
        void store.get("hang-kv").then(() => {
          settled = true;
        });

        // A disabled budget never abandons the KV read; it stays pending.
        await vi.advanceTimersByTimeAsync(1000);

        expect(settled).toBe(false);
        expect(warnSpy).not.toHaveBeenCalled();

        warnSpy.mockRestore();
      });
    });
  });
});
