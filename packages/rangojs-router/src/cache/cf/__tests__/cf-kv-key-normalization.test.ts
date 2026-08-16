/**
 * KV key-length normalization (production pilot finding #1).
 *
 * Cloudflare KV rejects keys over 512 UTF-8 bytes with
 * `414 ... exceeds key length limit of 512`. "use cache" item keys embed
 * serialized args (`use-cache:{functionId}:{serializedArgs}`), so a non-trivial
 * arg object (the pilot's CMS query) blows the cap and every L2 read/write for
 * that entry silently fails — the entry degrades to L1-only forever.
 *
 * toKVKey is the single composition chokepoint for every family; it now
 * normalizes over-limit keys to a preserved 400-byte prefix plus a 128-bit
 * SHA-256 digest of the full composed key. This suite drives the store against
 * a STRICT mock KV that enforces the real 512-byte rejection, so the
 * round-trips below fail on any code path that skips normalization — exactly
 * how the old code failed in production.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { CFCacheStore } from "../cf-cache-store";
import {
  KV_MAX_KEY_BYTES,
  kvKeyByteLength,
  truncateToBytes,
} from "../cf-kv-utils.js";

// L1 mock: minimal Cache API. Cleared between write and read so reads are
// forced through the KV (L2) tier under test.
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

const mockCaches = {
  _default: new MockCache(),
  async open(): Promise<MockCache> {
    return this._default;
  },
  get default(): MockCache {
    return this._default;
  },
  clear(): void {
    this._default.clear();
  },
};
(globalThis as any).caches = mockCaches;

/** KV mock enforcing the real 512-byte key rejection on every operation. */
class StrictKV {
  store = new Map<string, string>();
  private assertKey(key: string): void {
    const bytes = kvKeyByteLength(key);
    if (bytes > KV_MAX_KEY_BYTES) {
      throw new Error(
        `KV PUT failed: 414 UTF-8 encoded length of ${bytes} exceeds key length limit of ${KV_MAX_KEY_BYTES}.`,
      );
    }
  }
  async get(key: string, options?: { type?: string }): Promise<any> {
    this.assertKey(key);
    const raw = this.store.get(key);
    if (raw === undefined) return null;
    return options?.type === "json" ? JSON.parse(raw) : raw;
  }
  async put(
    key: string,
    value: string,
    _options?: { expirationTtl?: number },
  ): Promise<void> {
    this.assertKey(key);
    this.store.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.assertKey(key);
    this.store.delete(key);
  }
}

function createMockCtx() {
  const pending: Promise<any>[] = [];
  return {
    waitUntil: (p: Promise<any>) => {
      pending.push(Promise.resolve(p));
    },
    passThroughOnException: () => {},
    flush: async () => {
      await Promise.all(pending.splice(0));
    },
  };
}

describe("KV key normalization (512-byte limit)", () => {
  let ctx: ReturnType<typeof createMockCtx>;
  let kv: StrictKV;

  beforeEach(() => {
    vi.restoreAllMocks();
    mockCaches.clear();
    kv = new StrictKV();
    ctx = createMockCtx();
  });

  function makeStore() {
    return new CFCacheStore({
      ctx: ctx as any,
      kv: kv as any,
      baseUrl: "https://test.internal/",
      version: "v1",
    });
  }

  it('item family: a "use cache" key over 512 bytes round-trips through L2', async () => {
    const store = makeStore();
    // The pilot shape: use-cache:{functionId}:{big serialized args}.
    const hugeKey = `use-cache:getEntries:${"q".repeat(680)}`;

    await store.setItem("warm", "warm-value", { ttl: 300 });
    await store.setItem(hugeKey, "huge-value", { ttl: 300 });
    await ctx.flush();

    // Force the read through KV: wipe L1.
    mockCaches.clear();
    const result = await store.getItem(hugeKey);
    expect(result?.value).toBe("huge-value");

    // The stored KV key is normalized: bounded, prefix-readable, digest tail.
    const kvKeys = [...kv.store.keys()].filter((k) => k.includes("fn:"));
    const normalized = kvKeys.find((k) => k.includes("use-cache:getEntries:"));
    expect(normalized).toBeDefined();
    expect(kvKeyByteLength(normalized!)).toBeLessThanOrEqual(KV_MAX_KEY_BYTES);
    expect(normalized!.startsWith("v/v1/fn:use-cache:getEntries:")).toBe(true);
    expect(normalized!).toMatch(/~[0-9a-f]{32}$/);
  });

  it("document family: a response key over 512 bytes round-trips through L2", async () => {
    const store = makeStore();
    const hugeKey = `/search?${"long-filter-param=value&".repeat(30)}`;

    await store.putResponse(hugeKey, new Response("doc-body"), 300);
    await ctx.flush();

    mockCaches.clear();
    const result = await store.getResponse(hugeKey);
    expect(result).not.toBeNull();
    expect(await result!.response.text()).toBe("doc-body");
  });

  it("distinct long keys sharing a 500-byte prefix stay distinct", async () => {
    const store = makeStore();
    const sharedPrefix = "p".repeat(500);
    const keyA = `${sharedPrefix}-alpha`;
    const keyB = `${sharedPrefix}-beta`;

    await store.setItem(keyA, "value-A", { ttl: 300 });
    await store.setItem(keyB, "value-B", { ttl: 300 });
    await ctx.flush();

    mockCaches.clear();
    expect((await store.getItem(keyA))?.value).toBe("value-A");
    mockCaches.clear();
    expect((await store.getItem(keyB))?.value).toBe("value-B");
  });

  it("keys within the limit compose exactly as before (no digest, no truncation)", async () => {
    const store = makeStore();
    await store.setItem("short-key", "short-value", { ttl: 300 });
    await ctx.flush();

    const kvKeys = [...kv.store.keys()];
    expect(kvKeys).toContain("v/v1/fn:short-key");
  });

  it("truncateToBytes never splits a multibyte sequence into a mismatched key part", () => {
    // 3-byte characters straddling the boundary: the split sequence decodes to
    // U+FFFD, which is stripped — deterministic for identical input.
    const multibyte = "€".repeat(200); // 600 bytes
    const truncated = truncateToBytes(multibyte, 400);
    expect(kvKeyByteLength(truncated)).toBeLessThanOrEqual(400);
    expect(truncated).toBe(truncateToBytes(multibyte, 400));
    expect(truncated.includes("�")).toBe(false);
  });
});
