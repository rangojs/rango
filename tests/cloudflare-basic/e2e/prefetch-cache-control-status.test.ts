import { expect, test } from "@playwright/test";
import { useFixture, type Fixture } from "./fixture";
import { waitForHydration, testId } from "./helper";

/**
 * A failed prefetch must not carry the prefetch Cache-Control header. The
 * client drops the failed prefetch from its own cache, but the click's fetch
 * of the same URL uses the default cache mode, so a cached 500 would be
 * answered from the browser HTTP cache for the header's max-age even after the
 * route recovers. /prefetch-flaky throws until the flaky-ok cookie is set.
 */
function runSpec(f: Fixture): void {
  test("a failed prefetch has no cache-control and the click renders the recovered route", async ({
    page,
    context,
  }) => {
    await page.goto(f.url("/prefetch-flaky-from"));
    await waitForHydration(page);

    const isFlakyPrefetch = (url: string) => {
      const u = new URL(url);
      return (
        u.pathname === "/prefetch-flaky" && u.searchParams.has("_rsc_partial")
      );
    };

    const prefetched = page.waitForResponse((r) => isFlakyPrefetch(r.url()));
    await page.locator('[data-testid="flaky-link"]').hover();
    const res = await prefetched;
    expect(res.status()).toBe(500);
    expect(res.headers()["cache-control"]).toBeUndefined();

    await context.addCookies([
      { name: "flaky-ok", value: "1", url: f.url("/") },
    ]);
    await page.locator('[data-testid="flaky-link"]').click();
    await expect(testId(page, "flaky-ok")).toBeVisible();
    await expect(page).toHaveURL(/\/prefetch-flaky/);
  });
}

test.describe("prefetch-cache-control-status (dev)", () => {
  const f = useFixture({ root: ".", mode: "dev" });
  runSpec(f);
});

test.describe("prefetch-cache-control-status (production)", () => {
  test.setTimeout(120000);
  const f = useFixture({ root: ".", mode: "build" });
  runSpec(f);
});
