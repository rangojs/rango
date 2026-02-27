import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { CFCacheStore, CACHE_TAGS_HEADER } from "../cf/cf-cache-store.js";

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

  function createStore(onTagInvalidation?: (tags: string[]) => Promise<void>) {
    return new CFCacheStore({
      ctx: mockCtx,
      baseUrl: "https://test.internal/",
      version: "v1",
      onTagInvalidation,
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
  // onTagInvalidation callback
  // ========================================================================

  describe("revalidateTag()", () => {
    it("calls onTagInvalidation via waitUntil with the tag", async () => {
      const onInvalidation = vi.fn(async () => {});
      const store = createStore(onInvalidation);

      await store.revalidateTag("products");
      await mockCtx.flush();

      expect(onInvalidation).toHaveBeenCalledWith(["products"]);
      expect(mockCtx.waitUntil).toHaveBeenCalled();
    });

    it("warns when no onTagInvalidation callback is configured", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const store = createStore();

      await store.revalidateTag("products");

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("no onTagInvalidation"),
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
      const store = createStore(failingCallback);

      // Should not throw
      await store.revalidateTag("products");
      // Flush the waitUntil promise (which will reject)
      await mockCtx.flush().catch(() => {});

      expect(failingCallback).toHaveBeenCalledWith(["products"]);
      errorSpy.mockRestore();
    });
  });
});
