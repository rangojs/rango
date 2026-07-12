import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";

/**
 * Global `cache.searchParams` key filtering against the real CFCacheStore
 * (router.tsx sets `searchParams: { exclude: ["utm_*"] }`).
 *
 * The /test/spk-cached handler embeds Date.now(): an identical timestamp
 * across requests proves both URLs resolved to ONE cache slot, differing
 * timestamps prove distinct slots.
 */

function defineSearchParamsKeySpec(f: { url: (path: string) => string }) {
  test("excluded utm_* variants collapse onto one cache slot", async ({
    request,
  }) => {
    const res1 = await request.get(f.url("/test/spk-cached?utm_source=first"));
    expect(res1.status()).toBe(200);
    const body1 = await res1.json();
    expect(body1.source).toBe("spk-cached");
    // Key-only scope: the handler saw the full query string on the MISS.
    expect(body1.utm).toBe("first");

    // Poll until the async cache write lands, then a DIFFERENT excluded value
    // must be a HIT on the same slot -- byte-identical body, including the
    // first request's baked-in utm value.
    await expect(async () => {
      const res2 = await request.get(
        f.url("/test/spk-cached?utm_source=second"),
      );
      expect(res2.status()).toBe(200);
      const body2 = await res2.json();
      expect(body2.ts).toBe(body1.ts);
      expect(body2.utm).toBe("first");
    }).toPass({ timeout: 10_000 });

    // The bare path shares the same slot (excluded-only URL == no search).
    const res3 = await request.get(f.url("/test/spk-cached"));
    expect((await res3.json()).ts).toBe(body1.ts);
  });

  test("a non-excluded param still keys a distinct slot", async ({
    request,
  }) => {
    const res1 = await request.get(f.url("/test/spk-cached?page=1"));
    expect(res1.status()).toBe(200);
    const body1 = await res1.json();
    expect(body1.page).toBe("1");

    // Wait until page=1 is cached (stable ts on repeat) so the page=2 read
    // below cannot race the first write.
    await expect(async () => {
      const again = await request.get(f.url("/test/spk-cached?page=1"));
      expect((await again.json()).ts).toBe(body1.ts);
    }).toPass({ timeout: 10_000 });

    const res2 = await request.get(f.url("/test/spk-cached?page=2"));
    const body2 = await res2.json();
    expect(body2.page).toBe("2");
    expect(body2.ts).not.toBe(body1.ts);

    // Excluded params riding along do not fork the surviving-param slot.
    await expect(async () => {
      const res4 = await request.get(
        f.url("/test/spk-cached?page=1&utm_source=ride"),
      );
      expect((await res4.json()).ts).toBe(body1.ts);
    }).toPass({ timeout: 10_000 });
  });
}

test.describe("search-params cache key filtering (dev)", () => {
  const f = useFixture({ root: ".", mode: "dev" });
  defineSearchParamsKeySpec(f);
});

test.describe("search-params cache key filtering (production)", () => {
  const f = useFixture({ root: ".", mode: "build" });
  defineSearchParamsKeySpec(f);
});
