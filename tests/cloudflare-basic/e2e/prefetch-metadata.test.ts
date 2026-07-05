import { expect, test } from "@playwright/test";
import { useFixture, type Fixture } from "./fixture";

/**
 * The router is configured with non-default prefetch limits
 * (prefetchCacheSize: 25, prefetchConcurrency: 3 — see src/router.tsx). Those
 * are client-runtime knobs, so they reach the browser only via the initial RSC
 * payload metadata; the browser entry reads them once to size the in-memory
 * prefetch cache and the prefetch queue concurrency.
 *
 * This pins that the configured limits survive a real Cloudflare build and ride
 * along in the same metadata block as prefetchCacheTTL. Value correctness is
 * pinned by the router unit tests; here we assert the fields cross the wire in
 * both dev and production.
 */

function runPrefetchMetadataSpec(f: Fixture): void {
  test("initial RSC payload carries the configured prefetch limits", async ({
    page,
  }) => {
    // Full RSC request (not partial, not HTML): __rsc=1 -> Flight payload whose
    // metadata block includes the prefetch config.
    const res = await page.request.get(f.url("/?__rsc=1"), {
      headers: { "X-Rango-State": "test:1" },
    });

    expect(res.status()).toBe(200);
    const body = await res.text();
    // Assert the exact configured values (25/3, not the 100/2 defaults): these
    // counts ship un-transformed in the metadata, so this proves the option
    // propagated end-to-end through a real Cloudflare build, not just that the
    // field is present.
    expect(body).toMatch(/"prefetchCacheSize"\s*:\s*25\b/);
    expect(body).toMatch(/"prefetchConcurrency"\s*:\s*3\b/);
    // Non-default strategy ("none" vs the "viewport" default — manual mode,
    // see src/router.tsx): proves defaultPrefetch propagated end-to-end too.
    expect(body).toMatch(/"defaultPrefetch"\s*:\s*"none"/);
  });
}

test.describe("prefetch-metadata (dev)", () => {
  const f = useFixture({ root: ".", mode: "dev" });
  runPrefetchMetadataSpec(f);
});

test.describe("prefetch-metadata (production)", () => {
  const f = useFixture({ root: ".", mode: "build" });
  runPrefetchMetadataSpec(f);
});
