import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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
} from "../cf-cache-store.js";
import type { CachedEntryData } from "../../types.js";
import { runWithRequestContext } from "../../../server/request-context.js";
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

class MockCacheView {
  constructor(private readonly backing: MockCache) {}

  match(request: Request): Promise<Response | undefined> {
    return this.backing.match(request);
  }

  put(request: Request, response: Response): Promise<void> {
    return this.backing.put(request, response);
  }

  delete(request: Request): Promise<boolean> {
    return this.backing.delete(request);
  }
}

class MockCaches {
  private caches = new Map<string, MockCache>();
  private _default = new MockCache();

  async open(name: string): Promise<MockCacheView> {
    if (!this.caches.has(name)) {
      this.caches.set(name, new MockCache());
    }
    return new MockCacheView(this.caches.get(name)!);
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

  afterEach(() => {
    // Restore real timers so a fake-timer install cannot leak past this file if
    // vitest's per-file isolation is ever relaxed.
    vi.useRealTimers();
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

  describe("write acknowledgements", () => {
    it("returns failed when synchronous write setup throws", async () => {
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const store = new CFCacheStore({ ctx: createMockCtx() });
      (store as any).getCache = () => {
        throw new Error("cache unavailable");
      };

      const acknowledgements = await Promise.all([
        store.set("segment", createTestData(), 60),
        store.setItem("item", "value", { ttl: 60 }),
        store.putResponse("response", new Response("body"), 60),
      ]);

      expect(acknowledgements).toEqual([
        { outcome: "failed" },
        { outcome: "failed" },
        { outcome: "failed" },
      ]);
      error.mockRestore();
    });
  });

  describe("get/set", () => {
    it("should return null for missing key", async () => {
      const store = new CFCacheStore({ ctx: createMockCtx() });
      const result = hit(await store.get("missing-key"));
      expect(result).toBeNull();
    });

    it("should store and retrieve data", async () => {
      const mockCtx = createMockCtx();
      const store = new CFCacheStore({ ctx: mockCtx });
      const data = createTestData();

      await expect(store.set("test-key", data, 60)).resolves.toEqual({
        outcome: "scheduled",
      });
      // Execute waitUntil callback
      await mockCtx.waitUntil.mock.results[0].value;

      const result = hit(await store.get("test-key"));

      expect(result).not.toBeNull();
      expect(result!.data).toEqual(data);
      expect(result).toMatchObject({
        freshness: "fresh",
        revalidationClaimed: false,
      });
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
      const result = hit(await store.get("test-key"));
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
    it("reports fresh entries without claiming revalidation", async () => {
      vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));

      const mockCtx = createMockCtx();
      const store = new CFCacheStore({ ctx: mockCtx });
      const data = createTestData();

      await store.set("test-key", data, 60);
      await mockCtx.waitUntil.mock.results[0].value;

      // Still fresh
      vi.advanceTimersByTime(30 * 1000);

      const result = hit(await store.get("test-key"));
      expect(result).toMatchObject({
        freshness: "fresh",
        revalidationClaimed: false,
      });
    });

    it("reports stale entries and atomically claims revalidation", async () => {
      vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));

      const mockCtx = createMockCtx();
      const store = new CFCacheStore({ ctx: mockCtx });
      const data = createTestData();

      await store.set("test-key", data, 60, 300);
      await mockCtx.waitUntil.mock.results[0].value;

      // Past TTL but within SWR window
      vi.advanceTimersByTime(120 * 1000);

      // First get claims revalidation and marks the entry REVALIDATING.
      const result = hit(await store.get("test-key"));
      expect(result).toMatchObject({
        freshness: "stale",
        revalidationClaimed: true,
      });

      // Verify the entry is now marked as REVALIDATING
      const cache = mockCaches.default;
      const request = new Request(
        "https://rsc-dummy-host-1.com/" + encodeURIComponent("test-key"),
      );
      const response = await cache.match(request);
      expect(response?.headers.get(CACHE_STATUS_HEADER)).toBe("REVALIDATING");
    });

    it("keeps a guarded stale reader stale without claiming revalidation", async () => {
      vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));

      const mockCtx = createMockCtx();
      const store = new CFCacheStore({ ctx: mockCtx });
      const data = createTestData();

      await store.set("test-key", data, 60, 300);
      await mockCtx.waitUntil.mock.results[0].value;

      // Make it stale
      vi.advanceTimersByTime(120 * 1000);

      // First get - atomically marks as REVALIDATING
      const result1 = hit(await store.get("test-key"));
      expect(result1).toMatchObject({
        freshness: "stale",
        revalidationClaimed: true,
      });

      // Second get - already REVALIDATING, should not trigger again
      const result2 = hit(await store.get("test-key"));
      expect(result2).toMatchObject({
        freshness: "stale",
        revalidationClaimed: false,
      });
      // The guarded read is served from the re-serialized REVALIDATING re-put;
      // pin that the round-trip preserved the payload byte-for-byte.
      expect(result2?.data).toEqual(data);
    });

    it("should prevent thundering herd with concurrent requests", async () => {
      vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));

      const mockCtx = createMockCtx();
      const store = new CFCacheStore({ ctx: mockCtx });
      const data = createTestData();

      await store.set("test-key", data, 60, 300);
      await mockCtx.waitUntil.mock.results[0].value;

      // Make it stale
      vi.advanceTimersByTime(120 * 1000);

      const results = await Promise.all([
        store.get("test-key"),
        store.get("test-key"),
        store.get("test-key"),
      ]);
      const hits = results.map(hit);
      expect(hits.filter((result) => result?.revalidationClaimed)).toHaveLength(
        1,
      );
      for (const result of hits) {
        expect(result).toMatchObject({ freshness: "stale" });
        expect(result?.data).toEqual(data);
      }
    });

    it("shares concurrent claims across named-cache wrappers", async () => {
      vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));
      const mockCtx = createMockCtx();
      const store = new CFCacheStore({
        ctx: mockCtx,
        namespace: "concurrent-herd",
      });
      const data = createTestData();
      await store.set("test-key", data, 60, 300);
      await mockCtx.waitUntil.mock.results[0].value;
      vi.advanceTimersByTime(120 * 1000);

      const results = await Promise.all([
        store.get("test-key"),
        store.get("test-key"),
        store.get("test-key"),
      ]);
      expect(
        results.map(hit).filter((result) => result?.revalidationClaimed),
      ).toHaveLength(1);
    });

    it("keeps default and explicitly named default cache claims independent", async () => {
      vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));
      const defaultCtx = createMockCtx();
      const namedCtx = createMockCtx();
      const defaultStore = new CFCacheStore({ ctx: defaultCtx });
      const namedStore = new CFCacheStore({
        ctx: namedCtx,
        namespace: "default",
      });
      const data = createTestData();

      await defaultStore.set("namespace-collision", data, 60, 300);
      await namedStore.set("namespace-collision", data, 60, 300);
      await Promise.all([
        defaultCtx.waitUntil.mock.results[0].value,
        namedCtx.waitUntil.mock.results[0].value,
      ]);
      vi.advanceTimersByTime(120 * 1000);

      expect(hit(await defaultStore.get("namespace-collision"))).toMatchObject({
        freshness: "stale",
        revalidationClaimed: true,
      });
      expect(hit(await namedStore.get("namespace-collision"))).toMatchObject({
        freshness: "stale",
        revalidationClaimed: true,
      });
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

      const result = hit(await store.get("marker-fail"));

      // A failed marker write must not turn a good stale read into a null/miss.
      expect(result).not.toBeNull();
      expect(result!.data).toEqual(data);
      expect(result).toMatchObject({
        freshness: "stale",
        revalidationClaimed: true,
      });
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

      const result = hit(await store.get("test-key"));
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

      const result = hit(await store.get(key));
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
      const result = hit(await store.get("custom-key"));
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
      const result = hit(await store.get("fallback-key"));
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
      const result = hit(await resultPromise);

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

      const result = hit(await store.get("fast-key"));

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
      const result = hit(await resultPromise);

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
      const result = hit(await resultPromise);

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
      const result = hit(await resultPromise);

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
      const result = hit(await store.get("err-entry"));

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

      const result = hit(await store.get("dbg"));
      expect(result!.data).toEqual(data);

      const fresh = events.find((e) => e.op === "get" && e.key === "dbg");
      expect(fresh).toMatchObject({
        outcome: "l1-fresh",
        status: 200,
        // The stored cache status is surfaced raw (HIT here), distinct from the
        // computed isRevalidating, so an operator can tell HIT from a
        // REVALIDATING entry whose stamp aged out.
        cacheStatus: "HIT",
        freshness: "fresh",
        revalidationClaimed: false,
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
      const result = hit(await resultPromise);

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
      const result = hit(await resultPromise);

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
      expect(hit(await store.get("seg-stuck"))!.revalidationClaimed).toBe(true);
      // Remaining window = 360 - 120 = 240, NOT the original full-window 360.
      expect(lastPutCacheControl(putSpy)).toBe("public, max-age=240");

      // t = 150s: the guard lapses at MAX_REVALIDATION_INTERVAL, re-arm re-puts.
      vi.advanceTimersByTime(MAX_REVALIDATION_INTERVAL * 1000);
      expect(hit(await store.get("seg-stuck"))!.revalidationClaimed).toBe(true);
      // Keeps shrinking (210), proving retention is not restarted to 360.
      expect(lastPutCacheControl(putSpy)).toBe("public, max-age=210");

      // At the hard-expiry boundary the remaining floors to 1, never resets.
      vi.advanceTimersByTime(210 * 1000); // t = 360s
      hit(await store.get("seg-stuck"));
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
      expect((await store.getItem("fn-stuck"))!.revalidationClaimed).toBe(true);
      expect(lastPutCacheControl(putSpy)).toBe("public, max-age=240");

      vi.advanceTimersByTime(MAX_REVALIDATION_INTERVAL * 1000);
      expect((await store.getItem("fn-stuck"))!.revalidationClaimed).toBe(true);
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
      const result = hit(await store.get("promoted"));
      expect(result!.data).toEqual(data);
      // Drain the promote waitUntil so the L1 entry is written.
      for (const r of mockCtx.waitUntil.mock.results) await r.value;

      const putSpy = vi.spyOn(mockCaches.default, "put");

      // t = 120s: the promoted entry is now stale; its re-put must use the
      // remaining window derived from the carried deadline (240), not floor to 1.
      vi.advanceTimersByTime(120 * 1000);
      expect(hit(await store.get("promoted"))!.revalidationClaimed).toBe(true);
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

      const result = hit(await store.get("corrupt-seg"));

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

      const result = hit(await store.get("match-fail-seg"));

      // A fast match rejection is a miss that consults L2, not the outer catch.
      expect(result).not.toBeNull();
      expect(result!.data).toEqual(kvData);
      expect(kv.get).toHaveBeenCalled();

      matchSpy.mockRestore();
    });

    it("returns CACHE_READ_ERROR (not a miss) when the KV segment read itself fails", async () => {
      // kvGetSegment's swallowed failure used to surface as null: the PPR
      // replay composition classified it a REAL miss and the seeded doc
      // record substituted for a key partition the store could not actually
      // read. The sentinel keeps lookupRouteDetailed's `error` contract —
      // render uncached, no fallback. (Deliberately asserted WITHOUT the
      // hit() normalizer: normalizing the sentinel to null is exactly how
      // this regression stayed invisible.)
      const kv = {
        get: vi.fn(async () => {
          throw new Error("KV boom");
        }),
        put: vi.fn(),
        delete: vi.fn(),
      };
      const matchSpy = vi
        .spyOn(mockCaches.default, "match")
        .mockResolvedValue(undefined);
      const store = new CFCacheStore({ ctx: createMockCtx(), kv: kv as any });

      expect(await store.get("kv-fail-seg")).toBe(CACHE_READ_ERROR);
      expect(kv.get).toHaveBeenCalled();

      matchSpy.mockRestore();
    });

    it("returns CACHE_READ_ERROR when L1 match rejects and no KV is configured", async () => {
      // The L1 rejection is the only signal the read produced; without a KV
      // tier there is nothing to overrule it, and returning null classified
      // it a REAL miss that enabled the PPR seeded fallback.
      const matchSpy = vi
        .spyOn(mockCaches.default, "match")
        .mockRejectedValue(new Error("match boom"));
      const store = new CFCacheStore({ ctx: createMockCtx() });

      expect(await store.get("l1-fail-no-kv")).toBe(CACHE_READ_ERROR);

      matchSpy.mockRestore();
    });

    it("returns CACHE_READ_ERROR when L1 match rejects and KV genuinely misses", async () => {
      // A KV miss under a rejected L1 match is NOT proof of absence -- the
      // key may exist in the tier that failed.
      const kv = {
        get: vi.fn(async () => null),
        put: vi.fn(),
        delete: vi.fn(),
      };
      const matchSpy = vi
        .spyOn(mockCaches.default, "match")
        .mockRejectedValue(new Error("match boom"));
      const store = new CFCacheStore({ ctx: createMockCtx(), kv: kv as any });

      expect(await store.get("l1-fail-kv-miss")).toBe(CACHE_READ_ERROR);
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
      const result = hit(await resultPromise);

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
      const result = hit(await resultPromise);

      // Stale KV data is served, but revalidation is withheld (no herd).
      expect(result!.data).toEqual(kvData);
      expect(result).toMatchObject({
        freshness: "stale",
        revalidationClaimed: false,
      });
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

      const result = hit(await store.get("non200-seg"));

      expect(result!.data).toEqual(kvData);
      expect(result).toMatchObject({
        freshness: "stale",
        revalidationClaimed: false,
      });
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

      const result = hit(await store.get("missing-seg"));

      expect(result!.data).toEqual(kvData);
      expect(result).toMatchObject({
        freshness: "stale",
        revalidationClaimed: true,
      });
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

      const result = hit(await store.get("corrupt-stale-seg"));

      // A corrupt L1 body must still revalidate so a fresh render overwrites it.
      expect(result!.data).toEqual(kvData);
      expect(result).toMatchObject({
        freshness: "stale",
        revalidationClaimed: true,
      });
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
      expect(result).toMatchObject({
        freshness: "stale",
        revalidationClaimed: false,
      });
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
      expect(result).toMatchObject({
        freshness: "fresh",
        revalidationClaimed: false,
      });
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

    it("reports stale items and claims revalidation", async () => {
      vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));

      const mockCtx = createMockCtx();
      const store = new CFCacheStore({ ctx: mockCtx });

      await store.setItem("fn-stale", "stale-value", { ttl: 60, swr: 300 });
      await mockCtx.waitUntil.mock.results[0].value;

      // Past TTL, within SWR window
      vi.advanceTimersByTime(120 * 1000);

      const result = await store.getItem("fn-stale");
      expect(result).toMatchObject({
        freshness: "stale",
        revalidationClaimed: true,
      });
      expect(result!.value).toBe("stale-value");
    });

    it("claims one revalidator across concurrent stale item reads", async () => {
      vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));

      const mockCtx = createMockCtx();
      const store = new CFCacheStore({ ctx: mockCtx });

      await store.setItem("fn-herd", "value", { ttl: 60, swr: 300 });
      await mockCtx.waitUntil.mock.results[0].value;

      vi.advanceTimersByTime(120 * 1000);

      const results = await Promise.all([
        store.getItem("fn-herd"),
        store.getItem("fn-herd"),
        store.getItem("fn-herd"),
      ]);
      expect(
        results.filter((result) => result?.revalidationClaimed),
      ).toHaveLength(1);
      for (const result of results) {
        expect(result).toMatchObject({ freshness: "stale", value: "value" });
      }
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
      expect(result).toMatchObject({
        freshness: "stale",
        revalidationClaimed: true,
      });
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
      expect((await store.getItem("fn-stuck"))!.revalidationClaimed).toBe(true);
      // Recent REVALIDATING (within interval): guarded, no re-trigger.
      expect(await store.getItem("fn-stuck")).toMatchObject({
        freshness: "stale",
        revalidationClaimed: false,
      });

      // Once the stamp ages to MAX_REVALIDATION_INTERVAL, the guard expires and
      // the next get re-triggers, so a dropped revalidation can never pin the
      // entry stale forever.
      vi.advanceTimersByTime(MAX_REVALIDATION_INTERVAL * 1000);
      expect((await store.getItem("fn-stuck"))!.revalidationClaimed).toBe(true);
    });

    it("does not re-trigger one second before MAX_REVALIDATION_INTERVAL", async () => {
      vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));

      const mockCtx = createMockCtx();
      const store = new CFCacheStore({ ctx: mockCtx });

      await store.setItem("fn-edge", "value", { ttl: 60, swr: 300 });
      await mockCtx.waitUntil.mock.results[0].value;

      vi.advanceTimersByTime(120 * 1000);

      // Marks REVALIDATING (stamps revalidating-at = now).
      expect((await store.getItem("fn-edge"))!.revalidationClaimed).toBe(true);

      // One second before the interval elapses: still within the guard window.
      vi.advanceTimersByTime((MAX_REVALIDATION_INTERVAL - 1) * 1000);
      expect(await store.getItem("fn-edge")).toMatchObject({
        freshness: "stale",
        revalidationClaimed: false,
      });
    });

    it("reports fresh items without claiming revalidation", async () => {
      vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));

      const mockCtx = createMockCtx();
      const store = new CFCacheStore({ ctx: mockCtx });

      await store.setItem("fn-fresh", "fresh-value", { ttl: 60, swr: 300 });
      await mockCtx.waitUntil.mock.results[0].value;

      vi.advanceTimersByTime(30 * 1000);

      const result = await store.getItem("fn-fresh");
      expect(result).toMatchObject({
        freshness: "fresh",
        revalidationClaimed: false,
      });
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

      await expect(
        store.setItem("fn-async", "value", { ttl: 60 }),
      ).resolves.toEqual({ outcome: "scheduled" });

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

    it("reports fresh responses without claiming revalidation", async () => {
      vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));

      const mockCtx = createMockCtx();
      const store = new CFCacheStore({ ctx: mockCtx });

      await store.putResponse("doc-fresh", new Response("fresh"), 60, 300);
      await mockCtx.waitUntil.mock.results[0].value;

      vi.advanceTimersByTime(30 * 1000);
      const result = await store.getResponse("doc-fresh");
      expect(result).toMatchObject({
        freshness: "fresh",
        revalidationClaimed: false,
      });
    });

    it("reports stale responses and claims revalidation", async () => {
      vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));

      const mockCtx = createMockCtx();
      const store = new CFCacheStore({ ctx: mockCtx });

      await store.putResponse("doc-stale", new Response("stale"), 60, 300);
      await mockCtx.waitUntil.mock.results[0].value;

      // Past TTL, within SWR
      vi.advanceTimersByTime(120 * 1000);
      const result = await store.getResponse("doc-stale");
      expect(result).toMatchObject({
        freshness: "stale",
        revalidationClaimed: true,
      });
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
      expect(result).toMatchObject({
        freshness: "stale",
        revalidationClaimed: true,
      });
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

      await expect(
        store.putResponse("doc-async", new Response("body"), 60),
      ).resolves.toEqual({ outcome: "scheduled" });

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

    it("strips a per-client signal from a contaminated L1 entry on serve (Finding #3, L1 read side)", async () => {
      const mockCtx = createMockCtx();
      const store = new CFCacheStore({ ctx: mockCtx });

      await store.putResponse(
        "l1-leak",
        new Response("body", { headers: { "X-Custom": "keep" } }),
        60,
        300,
      );
      await mockCtx.waitUntil.mock.results[0].value;

      // Simulate a pre-fix L1 entry: re-seed the cached entry WITH a Set-Cookie
      // the write-side strip would have removed, then serve it.
      const l1Key = new Request(
        "https://rsc-dummy-host-1.com/" + encodeURIComponent("doc:l1-leak"),
      );
      const cached = (await mockCaches.default.match(l1Key))!;
      const tampered = new Headers(cached.headers);
      tampered.set("set-cookie", "session=clientA");
      await mockCaches.default.put(
        l1Key,
        new Response(await cached.arrayBuffer(), {
          status: cached.status,
          headers: tampered,
        }),
      );

      const result = await store.getResponse("l1-leak");
      expect(result).not.toBeNull();
      // toClientResponse strips the per-client signal on serve.
      expect(result!.response.headers.has("set-cookie")).toBe(false);
      expect(result!.response.headers.get("X-Custom")).toBe("keep");
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
  // Document-tier thundering-herd guard (A2)
  // ==========================================================================
  // Mirrors the segment (get) / item (getItem) REVALIDATING guard for the
  // document tier. Before this, every concurrent stale getResponse claimed
  // revalidation, so document-cache.ts scheduled a fresh render for each one (a
  // herd). Now the first stale reader marks REVALIDATING and a recent marker
  // suppresses ownership for subsequent readers without changing freshness.

  describe("getResponse document-tier herd guard", () => {
    it("first stale getResponse marks REVALIDATING and claims ownership", async () => {
      vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));
      const mockCtx = createMockCtx();
      const store = new CFCacheStore({ ctx: mockCtx });

      await store.putResponse("doc-herd", new Response("body"), 60, 300);
      await mockCtx.waitUntil.mock.results[0].value;

      // Past TTL, within SWR.
      vi.advanceTimersByTime(120 * 1000);

      const first = await store.getResponse("doc-herd");
      expect(first).toMatchObject({
        freshness: "stale",
        revalidationClaimed: true,
      });
      expect(await first!.response.text()).toBe("body");

      // The L1 entry is now stamped REVALIDATING.
      const cache = mockCaches.default;
      const request = new Request(
        "https://rsc-dummy-host-1.com/" + encodeURIComponent("doc:doc-herd"),
      );
      const marked = await cache.match(request);
      expect(marked?.headers.get(CACHE_STATUS_HEADER)).toBe("REVALIDATING");
      // The served stale body must survive the clone-for-marker round-trip.
      expect(await marked!.text()).toBe("body");
    });

    it("only one of N stale getResponse reads claims revalidation", async () => {
      vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));
      const mockCtx = createMockCtx();
      const store = new CFCacheStore({ ctx: mockCtx });

      await store.putResponse("doc-herd-seq", new Response("body"), 60, 300);
      await mockCtx.waitUntil.mock.results[0].value;

      vi.advanceTimersByTime(120 * 1000);

      const [r1, r2, r3] = await Promise.all([
        store.getResponse("doc-herd-seq"),
        store.getResponse("doc-herd-seq"),
        store.getResponse("doc-herd-seq"),
      ]);

      const revalidators = [r1, r2, r3].filter((r) => r!.revalidationClaimed);
      expect(revalidators.length).toBe(1);
      for (const result of [r1, r2, r3]) {
        expect(result).toMatchObject({ freshness: "stale" });
      }
      // Every reader still gets the full stale body.
      expect(await r1!.response.text()).toBe("body");
      expect(await r2!.response.text()).toBe("body");
      expect(await r3!.response.text()).toBe("body");
    });

    it("re-arms revalidation after the REVALIDATING stamp ages past MAX_REVALIDATION_INTERVAL", async () => {
      vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));
      const mockCtx = createMockCtx();
      const store = new CFCacheStore({ ctx: mockCtx });

      // Long SWR so the entry stays stale-but-servable across the whole window.
      await store.putResponse("doc-rearm", new Response("body"), 60, 3000);
      await mockCtx.waitUntil.mock.results[0].value;

      vi.advanceTimersByTime(120 * 1000); // stale
      expect((await store.getResponse("doc-rearm"))!.revalidationClaimed).toBe(
        true,
      );
      // Guarded immediately after.
      expect(await store.getResponse("doc-rearm")).toMatchObject({
        freshness: "stale",
        revalidationClaimed: false,
      });

      // Past the recency window: the next stale read re-arms.
      vi.advanceTimersByTime((MAX_REVALIDATION_INTERVAL + 1) * 1000);
      expect((await store.getResponse("doc-rearm"))!.revalidationClaimed).toBe(
        true,
      );
    });

    it("returns the claimed stale response even when the marker write fails", async () => {
      vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));
      const mockCtx = createMockCtx();
      const store = new CFCacheStore({ ctx: mockCtx });

      await store.putResponse("doc-marker-fail", new Response("body"), 60, 300);
      await mockCtx.waitUntil.mock.results[0].value;

      vi.advanceTimersByTime(120 * 1000);

      // Fail the (best-effort) marker re-put. The served stale read must be
      // unaffected; it simply re-arms on the next stale read.
      vi.spyOn(mockCaches.default, "put").mockRejectedValue(
        new Error("cache.put failed"),
      );

      const result = await store.getResponse("doc-marker-fail");
      expect(result).toMatchObject({
        freshness: "stale",
        revalidationClaimed: true,
      });
      expect(await result!.response.text()).toBe("body");
    });

    it("does not leak the internal expires-at / revalidating-at headers to the client", async () => {
      vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));
      const mockCtx = createMockCtx();
      const store = new CFCacheStore({ ctx: mockCtx });

      await store.putResponse("doc-leak", new Response("body"), 60, 300);
      await mockCtx.waitUntil.mock.results[0].value;

      vi.advanceTimersByTime(120 * 1000);
      const result = await store.getResponse("doc-leak");
      // A2 stamps CACHE_EXPIRES_AT_HEADER on the doc entry and the marker adds
      // CACHE_REVALIDATING_AT_HEADER; toClientResponse must strip both.
      expect(
        result!.response.headers.get("x-edge-cache-expires-at"),
      ).toBeNull();
      expect(
        result!.response.headers.get(CACHE_REVALIDATING_AT_HEADER),
      ).toBeNull();
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

        const result = hit(await store.get("seg-key"));
        expect(result).not.toBeNull();
        expect(result!.data).toEqual(data);
        expect(result).toMatchObject({
          freshness: "fresh",
          revalidationClaimed: false,
        });
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
        const result = hit(await store.get("seg-fresh"));

        expect(result).toMatchObject({
          freshness: "fresh",
          revalidationClaimed: false,
        });
        expect(events.at(-1)).toMatchObject({
          op: "get",
          outcome: "kv-fresh",
          freshness: "fresh",
          revalidationClaimed: false,
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
        const result = hit(await store.get("seg-stale"));

        expect(result).toMatchObject({
          freshness: "stale",
          revalidationClaimed: true,
        });
        mockCaches.clear();
        expect(hit(await store.get("seg-stale"))).toMatchObject({
          freshness: "stale",
          revalidationClaimed: false,
        });
        vi.advanceTimersByTime(MAX_REVALIDATION_INTERVAL * 1000);
        mockCaches.clear();
        expect(hit(await store.get("seg-stale"))).toMatchObject({
          freshness: "stale",
          revalidationClaimed: true,
        });
        expect(events.at(-1)).toMatchObject({
          op: "get",
          outcome: "kv-stale",
          freshness: "stale",
          revalidationClaimed: true,
        });
      });

      it("emits a kv-miss debug event when neither tier has the entry", async () => {
        const events: CFCacheReadDebugEvent[] = [];
        const store = new CFCacheStore({
          ctx: createMockCtx(),
          kv: mockKV as any,
          debug: (e) => events.push(e),
        });

        const result = hit(await store.get("nowhere"));

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
        const result = hit(await store.get("short-ttl"));
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

      it("reports stale KV entries and claims revalidation", async () => {
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

        const result = hit(await store.get("seg-key"));
        expect(result).not.toBeNull();
        expect(result!.data).toEqual(data);
        expect(result).toMatchObject({
          freshness: "stale",
          revalidationClaimed: true,
        });
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

        const result = hit(await store.get("seg-key"));
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
        const kvResult = hit(await store.get("seg-key"));
        expect(kvResult).not.toBeNull();

        // Wait for promote waitUntil
        for (const result of mockCtx.waitUntil.mock.results) {
          await result.value;
        }

        // Clear KV to prove L1 has the entry now
        mockKV.clear();

        // Should now hit L1
        const l1Result = hit(await store.get("seg-key"));
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

        hit(await store.get("seg-key"));
        // KV.get should not have been called (L1 hit)
        expect(kvGetSpy).not.toHaveBeenCalled();
      });

      it("should return null when both L1 and KV miss", async () => {
        const mockCtx = createMockCtx();
        const store = new CFCacheStore({ ctx: mockCtx, kv: mockKV as any });

        const result = hit(await store.get("missing-key"));
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
        expect(result).toMatchObject({
          freshness: "fresh",
          revalidationClaimed: false,
        });
      });

      it("reports stale KV function entries and claims revalidation", async () => {
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
        expect(result).toMatchObject({
          freshness: "stale",
          revalidationClaimed: true,
        });
        mockCaches.clear();
        expect(await store.getItem("fn-key")).toMatchObject({
          freshness: "stale",
          revalidationClaimed: false,
        });
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
          freshness: "stale",
          revalidationClaimed: true,
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

        // Document KV keys are host-namespaced (A3): the L1 tier namespaces by
        // host, so the KV twin must too, else two hosts could collide on KV.
        // Default fallback host (no baseUrl) is rsc-dummy-host-1.com.
        const kvEntry = mockKV.store.get("h/rsc-dummy-host-1.com/doc:doc-key");
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

      it("namespaces the document KV key by host so two hosts do not collide (A3)", async () => {
        // Two stores on different hosts write the SAME document key+path. The L1
        // tier already namespaces by host via keyToRequest/resolveBaseUrl; the KV
        // fallback used to key only on `doc:{key}`, so host B's write would clobber
        // host A's KV entry (and host B could be served host A's cached document).
        const mockCtx = createMockCtx();
        const storeA = new CFCacheStore({
          ctx: mockCtx,
          kv: mockKV as any,
          baseUrl: "https://a.example.com/",
        });
        const storeB = new CFCacheStore({
          ctx: mockCtx,
          kv: mockKV as any,
          baseUrl: "https://b.example.com/",
        });

        await storeA.putResponse("same-path", new Response("from-A"), 60, 300);
        await storeB.putResponse("same-path", new Response("from-B"), 60, 300);
        for (const result of mockCtx.waitUntil.mock.results) {
          await result.value;
        }

        // Distinct, host-prefixed KV keys; neither host clobbers the other.
        const keyA = "h/a.example.com/doc:same-path";
        const keyB = "h/b.example.com/doc:same-path";
        expect(keyA).not.toBe(keyB);
        const entryA = mockKV.store.get(keyA);
        const entryB = mockKV.store.get(keyB);
        expect(entryA).toBeDefined();
        expect(entryB).toBeDefined();
        expect(JSON.parse(entryA!.value).b).toBe(btoa("from-A"));
        expect(JSON.parse(entryB!.value).b).toBe(btoa("from-B"));
        // Exactly two doc entries -> no collision onto one slot.
        const docKeys = [...mockKV.store.keys()].filter((k) =>
          k.includes("doc:same-path"),
        );
        expect(docKeys.length).toBe(2);
      });

      it("reads back the host-namespaced document KV entry on L1 miss (round-trip)", async () => {
        vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));
        const mockCtx = createMockCtx();
        const store = new CFCacheStore({
          ctx: mockCtx,
          kv: mockKV as any,
          baseUrl: "https://roundtrip.example.com/",
        });

        await store.putResponse("doc-rt", new Response("round-trip"), 60, 300);
        for (const result of mockCtx.waitUntil.mock.results) {
          await result.value;
        }

        // L1 gone; the KV read must locate the host-namespaced key, not a bare
        // `doc:` key (which would miss and force a render).
        mockCaches.clear();
        const result = await store.getResponse("doc-rt");
        expect(result).not.toBeNull();
        expect(await result!.response.text()).toBe("round-trip");
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
        expect(result).toMatchObject({
          freshness: "fresh",
          revalidationClaimed: false,
        });
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

      it("strips per-client signals replayed from a pre-fix KV envelope on read (Finding #3)", async () => {
        vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));

        const mockCtx = createMockCtx();
        const store = new CFCacheStore({ ctx: mockCtx, kv: mockKV as any });

        await store.putResponse(
          "leaky-doc",
          new Response("body", { headers: { "X-Custom": "keep" } }),
          60,
          300,
        );
        for (const result of mockCtx.waitUntil.mock.results) {
          await result.value;
        }

        // Simulate an envelope written before the write-side strip shipped (or
        // persisted under a pinned `version`): inject per-client signals into
        // the stored headers. The read path must not replay them cross-client.
        const kvEntry = mockKV.store.get(
          "h/rsc-dummy-host-1.com/doc:leaky-doc",
        )!;
        const envelope = JSON.parse(kvEntry.value);
        envelope.hd.push(["set-cookie", "session=clientA"]);
        envelope.hd.push(["x-rango-keep-cache", "1"]);
        kvEntry.value = JSON.stringify(envelope);

        // Serve from KV (L1 cleared) to a different client.
        mockCaches.clear();
        const result = await store.getResponse("leaky-doc");
        expect(result).not.toBeNull();
        expect(result!.response.headers.has("set-cookie")).toBe(false);
        expect(result!.response.headers.has("x-rango-keep-cache")).toBe(false);
        // Unrelated headers still pass through.
        expect(result!.response.headers.get("X-Custom")).toBe("keep");
      });

      it("evicts (not generic-errors) a KV envelope with a malformed hd element on read", async () => {
        vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));

        const mockCtx = createMockCtx();
        const store = new CFCacheStore({ ctx: mockCtx, kv: mockKV as any });

        await store.putResponse("bad-hd", new Response("body"), 60, 300);
        for (const result of mockCtx.waitUntil.mock.results) {
          await result.value;
        }

        // hd passes the Array.isArray validation but holds a non-pair element,
        // which throws when the read-side strip destructures it. The strip lives
        // INSIDE the corrupt-envelope try, so the throw evicts the poisoned entry
        // rather than surfacing as a generic cache-read that leaves it to re-fail
        // every read until TTL.
        const kvDocKey = "h/rsc-dummy-host-1.com/doc:bad-hd";
        const kvEntry = mockKV.store.get(kvDocKey)!;
        const envelope = JSON.parse(kvEntry.value);
        envelope.hd.push(42);
        kvEntry.value = JSON.stringify(envelope);

        mockCaches.clear();
        mockCtx.waitUntil.mockClear();

        const result = await store.getResponse("bad-hd");
        expect(result).toBeNull();
        // Drain the scheduled eviction and confirm the poisoned key is gone.
        for (const r of mockCtx.waitUntil.mock.results) {
          await r.value;
        }
        expect(mockKV.store.has(kvDocKey)).toBe(false);
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

        const result = hit(await store.get("del-key"));
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

        const result = hit(await store.get("any-key"));
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
        const result = hit(await store.get("seg-key"));
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
        const result = hit(await resultPromise);

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

        const result = hit(await store.get("err-kv"));

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
        const result = hit(await resultPromise);

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
