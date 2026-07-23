import { describe, it, expect, vi, afterEach } from "vitest";
import {
  resolveTtl,
  resolveSwrWindow,
  computeExpiration,
  resolveCacheKey,
  resolveCacheStore,
  resolveTagsOption,
  DEFAULT_ROUTE_TTL,
  DEFAULT_FUNCTION_TTL,
} from "../cache-policy.js";
import {
  getRequestContext,
  _getRequestContext,
} from "../../server/request-context.js";

vi.mock("../../server/request-context.js");

const mockedGetCtx = vi.mocked(getRequestContext);
const mockedGetCtxInternal = vi.mocked(_getRequestContext);

describe("resolveTtl", () => {
  it("returns explicit value when provided", () => {
    expect(resolveTtl(30, { ttl: 60 }, 120)).toBe(30);
  });

  it("falls back to store defaults when explicit is undefined", () => {
    expect(resolveTtl(undefined, { ttl: 60 }, 120)).toBe(60);
  });

  it("falls back to fallback when both explicit and defaults are undefined", () => {
    expect(resolveTtl(undefined, undefined, 120)).toBe(120);
  });

  it("falls back to fallback when defaults has no ttl", () => {
    expect(resolveTtl(undefined, { swr: 10 }, 120)).toBe(120);
  });

  it("allows explicit 0", () => {
    expect(resolveTtl(0, { ttl: 60 }, 120)).toBe(0);
  });

  it("allows defaults 0", () => {
    expect(resolveTtl(undefined, { ttl: 0 }, 120)).toBe(0);
  });

  it("degrades a non-finite explicit ttl to the fallback", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(resolveTtl(NaN, { ttl: 60 }, 120)).toBe(120);
    expect(resolveTtl(Infinity, undefined, 120)).toBe(120);
    warn.mockRestore();
  });

  it("degrades a negative explicit ttl to the fallback", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(resolveTtl(-5, { ttl: 60 }, 120)).toBe(120);
    warn.mockRestore();
  });

  it("degrades a non-finite/negative store-default ttl to the fallback", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(resolveTtl(undefined, { ttl: NaN }, 120)).toBe(120);
    expect(resolveTtl(undefined, { ttl: -1 }, 120)).toBe(120);
    warn.mockRestore();
  });
});

describe("resolveSwrWindow", () => {
  it("returns explicit value when provided", () => {
    expect(resolveSwrWindow(30, { swr: 60 })).toBe(30);
  });

  it("falls back to store defaults when explicit is undefined", () => {
    expect(resolveSwrWindow(undefined, { swr: 60 })).toBe(60);
  });

  it("returns 0 when both are undefined", () => {
    expect(resolveSwrWindow(undefined, undefined)).toBe(0);
  });

  it("returns 0 when defaults has no swr", () => {
    expect(resolveSwrWindow(undefined, { ttl: 60 })).toBe(0);
  });

  it("allows explicit 0", () => {
    expect(resolveSwrWindow(0, { swr: 60 })).toBe(0);
  });

  it("degrades a non-finite/negative swr to 0 (no SWR window)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(resolveSwrWindow(NaN, { swr: 60 })).toBe(0);
    expect(resolveSwrWindow(-10, undefined)).toBe(0);
    expect(resolveSwrWindow(undefined, { swr: Infinity })).toBe(0);
    warn.mockRestore();
  });
});

describe("computeExpiration", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("computes staleAt and expiresAt from TTL", () => {
    vi.spyOn(Date, "now").mockReturnValue(1000000);
    const result = computeExpiration(60);
    expect(result.staleAt).toBe(1000000 + 60 * 1000);
    expect(result.expiresAt).toBe(1000000 + 60 * 1000);
  });

  it("extends expiresAt by SWR window", () => {
    vi.spyOn(Date, "now").mockReturnValue(1000000);
    const result = computeExpiration(60, 300);
    expect(result.staleAt).toBe(1000000 + 60 * 1000);
    expect(result.expiresAt).toBe(1000000 + (60 + 300) * 1000);
  });

  it("staleAt equals expiresAt when SWR is 0", () => {
    const result = computeExpiration(60, 0);
    expect(result.staleAt).toBe(result.expiresAt);
  });
});

describe("constants", () => {
  it("DEFAULT_ROUTE_TTL is 60", () => {
    expect(DEFAULT_ROUTE_TTL).toBe(60);
  });

  it("DEFAULT_FUNCTION_TTL is 900", () => {
    expect(DEFAULT_FUNCTION_TTL).toBe(900);
  });
});

function setMockCtx(ctx: any) {
  mockedGetCtx.mockReturnValue(ctx);
  mockedGetCtxInternal.mockReturnValue(ctx);
}

// resolveCacheKey and resolveCacheStore use _getRequestContext (non-throwing).
// Outside ALS they return defaultKey/null rather than throwing.
// Errors from explicit keyFn or store.keyGenerator propagate (hard-fail):
// cache identity is correctness-critical, silent fallback risks collisions.

describe("resolveCacheKey", () => {
  afterEach(() => {
    setMockCtx(undefined);
  });

  it("uses keyFn when provided (priority 1)", async () => {
    setMockCtx({ url: new URL("http://localhost/") });
    const keyFn = vi.fn().mockResolvedValue("custom:key");
    const store = {
      keyGenerator: vi.fn().mockResolvedValue("modified:key"),
    } as any;
    const result = await resolveCacheKey(keyFn, store, "default:key", "Test");
    expect(result).toBe("custom:key");
    expect(store.keyGenerator).not.toHaveBeenCalled();
  });

  it("uses store.keyGenerator when no keyFn (priority 2)", async () => {
    setMockCtx({ url: new URL("http://localhost/") });
    const store = {
      keyGenerator: vi.fn(async (_ctx: any, dk: string) => `modified:${dk}`),
    } as any;
    const result = await resolveCacheKey(
      undefined,
      store,
      "default:key",
      "Test",
    );
    expect(result).toBe("modified:default:key");
  });

  it("returns defaultKey when no keyFn and no keyGenerator (priority 3)", async () => {
    setMockCtx({ url: new URL("http://localhost/") });
    const result = await resolveCacheKey(
      undefined,
      null,
      "default:key",
      "Test",
    );
    expect(result).toBe("default:key");
  });

  it("throws when keyFn throws (hard-fail, no silent fallback)", async () => {
    setMockCtx({ url: new URL("http://localhost/") });
    const keyFn = vi.fn().mockRejectedValue(new Error("boom"));
    const store = {
      keyGenerator: vi.fn(async (_ctx: any, dk: string) => `modified:${dk}`),
    } as any;
    await expect(
      resolveCacheKey(keyFn, store, "default:key", "Test"),
    ).rejects.toThrow("boom");
    // keyGenerator must not be called as a fallback
    expect(store.keyGenerator).not.toHaveBeenCalled();
  });

  it("throws when store.keyGenerator throws (hard-fail, no silent fallback)", async () => {
    setMockCtx({ url: new URL("http://localhost/") });
    const store = {
      keyGenerator: vi.fn().mockRejectedValue(new Error("gen error")),
    } as any;
    await expect(
      resolveCacheKey(undefined, store, "default:key", "Test"),
    ).rejects.toThrow("gen error");
  });

  it("gracefully returns defaultKey outside ALS (no request context)", async () => {
    // _getRequestContext returns undefined outside ALS — keyFn/keyGenerator are skipped
    const keyFn = vi.fn().mockResolvedValue("custom:key");
    const store = { keyGenerator: vi.fn().mockResolvedValue("mod:key") } as any;
    const result = await resolveCacheKey(keyFn, store, "default:key", "Test");
    expect(result).toBe("default:key");
    expect(keyFn).not.toHaveBeenCalled();
    expect(store.keyGenerator).not.toHaveBeenCalled();
  });
});

describe("resolveCacheStore", () => {
  afterEach(() => {
    setMockCtx(undefined);
  });

  it("returns explicit store when provided", () => {
    const store = { get: vi.fn(), set: vi.fn(), delete: vi.fn() } as any;
    expect(resolveCacheStore(store)).toBe(store);
  });

  it("returns app-level store from request context", () => {
    const store = { get: vi.fn(), set: vi.fn(), delete: vi.fn() } as any;
    setMockCtx({ _cacheStore: store });
    expect(resolveCacheStore(undefined)).toBe(store);
  });

  it("prefers explicit store over request context store", () => {
    const explicit = { get: vi.fn(), set: vi.fn(), delete: vi.fn() } as any;
    const appLevel = { get: vi.fn(), set: vi.fn(), delete: vi.fn() } as any;
    setMockCtx({ _cacheStore: appLevel });
    expect(resolveCacheStore(explicit)).toBe(explicit);
  });

  it("returns null outside ALS (no request context)", () => {
    // _getRequestContext returns undefined outside ALS — returns null, not throws
    expect(resolveCacheStore(undefined)).toBeNull();
  });

  it("returns null when request context has no cache store", () => {
    setMockCtx({});
    expect(resolveCacheStore(undefined)).toBeNull();
  });
});

describe("resolveTagsOption tag normalization (N3)", () => {
  afterEach(() => vi.clearAllMocks());

  it("drops empty/whitespace-only tags from a static array (write/invalidate parity)", () => {
    expect(resolveTagsOption(["", "  ", "products"], undefined, "T")).toEqual([
      "products",
    ]);
  });

  it("returns undefined when a static array has no usable tags", () => {
    expect(resolveTagsOption(["", "   "], undefined, "T")).toBeUndefined();
  });

  it("normalizes tags returned by a dynamic function too", () => {
    const ctx = {} as any;
    expect(resolveTagsOption(() => ["a", " ", "b"], ctx, "T")).toEqual([
      "a",
      "b",
    ]);
  });

  it("returns undefined for an undefined tags option", () => {
    expect(resolveTagsOption(undefined, undefined, "T")).toBeUndefined();
  });
});
