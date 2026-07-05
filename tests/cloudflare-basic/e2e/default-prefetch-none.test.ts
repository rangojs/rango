import { expect, test } from "@playwright/test";
import { isPrefetchRequest } from "@rangojs/router/testing/e2e";
import { useFixture, type Fixture } from "./fixture";
import { waitForHydration } from "./helper";

/**
 * Manual prefetch mode: this app sets createRouter({ defaultPrefetch: "none" })
 * (src/router.tsx), opting out of the router's default-on viewport prefetch.
 * Pins the two sides of the manual-mode contract:
 *
 *   1. Bare Links (no `prefetch` prop) issue NO speculative prefetches — the
 *      router default resolved to "none" and reached the client.
 *   2. A per-Link `prefetch` prop still opts in — manual mode changes the
 *      fallback, not the per-Link override.
 *
 * Every speculative prefetch carries the X-Rango-Prefetch header
 * (browser/prefetch/fetch.ts), which is what both tests key on.
 */

function runDefaultPrefetchNoneSpec(f: Fixture): void {
  test("bare Links do not prefetch under defaultPrefetch: 'none'", async ({
    page,
  }) => {
    const prefetchRequests: string[] = [];
    page.on("request", (req) => {
      if (isPrefetchRequest(req)) {
        prefetchRequests.push(req.url());
      }
    });

    // Home renders bare Links (and hover-strategy entry links, which cannot
    // fire without a hover). Under the default-on fallback the bare Links
    // would enqueue viewport prefetches as soon as the app goes idle.
    await page.goto(f.url("/"));
    await waitForHydration(page);

    // Idle window in which the viewport default would have fired — the
    // idle-gated queue drains promptly once hydration settles.
    await page.waitForTimeout(2000);

    expect(prefetchRequests).toHaveLength(0);
  });

  test("a per-Link prefetch prop still opts in under manual mode", async ({
    page,
  }) => {
    await page.goto(f.url("/pt-layout/from"));
    await waitForHydration(page);

    const prefetchRequest = page.waitForRequest(
      (req) => isPrefetchRequest(req) && req.url().includes("/pt-layout/to"),
    );
    await page.getByTestId("pt-to-link").hover();

    const req = await prefetchRequest;
    expect(req.url()).toContain("_rsc_partial");
  });
}

test.describe("default-prefetch-none (dev)", () => {
  const f = useFixture({ root: ".", mode: "dev" });
  runDefaultPrefetchNoneSpec(f);
});

test.describe("default-prefetch-none (production)", () => {
  const f = useFixture({ root: ".", mode: "build" });
  runDefaultPrefetchNoneSpec(f);
});
