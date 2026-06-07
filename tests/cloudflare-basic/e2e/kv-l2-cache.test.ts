import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";

/**
 * Tests KV L2 cache persistence in CFCacheStore.
 *
 * Verifies that when `kv` is configured on CFCacheStore:
 * 1. Cache writes populate KV (L2) alongside the Cache API (L1)
 * 2. Cached responses are still served correctly (no regression)
 * 3. KV entries are queryable via the KV namespace
 */

test.describe("KV L2 cache (dev)", () => {
  const f = useFixture({ root: ".", mode: "dev" });

  test("cached route populates KV L2", async ({ request }) => {
    // Hit the cached route to trigger a cache write to both L1 and KV
    const res1 = await request.get(f.url("/test/kv-cached-json"));
    expect(res1.status()).toBe(200);
    const body1 = await res1.json();
    const ts1 = body1.ts;
    expect(typeof ts1).toBe("number");

    // Give waitUntil a moment to flush KV write
    await new Promise((r) => setTimeout(r, 500));

    // Verify KV has entries
    const kvRes = await request.get(f.url("/test/kv-l2-check"));
    expect(kvRes.status()).toBe(200);
    const kvBody = await kvRes.json();
    expect(kvBody.kvKeyCount).toBeGreaterThan(0);
  });

  test("cached route serves from cache with KV enabled", async ({
    request,
  }) => {
    // First request populates cache
    const res1 = await request.get(f.url("/test/kv-cached-json"));
    expect(res1.status()).toBe(200);
    const body1 = await res1.json();
    const ts1 = body1.ts;

    await new Promise((r) => setTimeout(r, 500));

    // Second request should serve from cache (same timestamp)
    const res2 = await request.get(f.url("/test/kv-cached-json"));
    expect(res2.status()).toBe(200);
    const body2 = await res2.json();

    expect(body2.ts).toBe(ts1);
  });
});

test.describe("KV L2 cache (production)", () => {
  const f = useFixture({ root: ".", mode: "build" });

  test("cached route populates KV L2 in production", async ({ request }) => {
    const res1 = await request.get(f.url("/test/kv-cached-json"));
    expect(res1.status()).toBe(200);
    const body1 = await res1.json();
    expect(typeof body1.ts).toBe("number");

    await new Promise((r) => setTimeout(r, 500));

    const kvRes = await request.get(f.url("/test/kv-l2-check"));
    expect(kvRes.status()).toBe(200);
    const kvBody = await kvRes.json();
    expect(kvBody.kvKeyCount).toBeGreaterThan(0);
  });

  test("cached route serves from cache with KV enabled in production", async ({
    request,
  }) => {
    const res1 = await request.get(f.url("/test/kv-cached-json"));
    expect(res1.status()).toBe(200);
    const body1 = await res1.json();
    const ts1 = body1.ts;

    await new Promise((r) => setTimeout(r, 500));

    const res2 = await request.get(f.url("/test/kv-cached-json"));
    expect(res2.status()).toBe(200);
    const body2 = await res2.json();

    expect(body2.ts).toBe(ts1);
  });
});
