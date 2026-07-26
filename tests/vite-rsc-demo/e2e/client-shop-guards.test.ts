import { expect, test, type Page } from "@playwright/test";
import { test as devTest, devURL } from "./dev-fixture";
import { waitForHydration, prodDescribe } from "./helper";

/**
 * Outer layout + middleware semantics around a clientUrls() mount
 * (docs/client-urls.md "Outer layouts and middleware across group
 * navigations"). The /client-shop include is wrapped
 * layout(ClientShopOuterLayout) -> middleware(clientShopGuardMiddleware) ->
 * include (src/urls/client-shop-guard.tsx). Contract pinned here:
 *
 * - Middleware wraps EVERY canonical request into the group — the document
 *   load AND each within-group soft navigation, including a same-route tab
 *   switch whose loaders all HOLD via client-run revalidate() decisions. The
 *   monotonic x-client-shop-mw header proves each request ran it.
 * - The outer server layout handler does NOT re-run on within-group
 *   navigations: its DOM stamp (run count) is unchanged across them —
 *   partial rendering holds the segment.
 */

async function outerStamp(page: Page): Promise<string> {
  const stamp = await page
    .locator('[data-testid="client-shop-outer"]')
    .getAttribute("data-stamp");
  expect(stamp).toBeTruthy();
  return stamp!;
}

function mwHeader(headers: Record<string, string>): number {
  const value = headers["x-client-shop-mw"];
  expect(value, "middleware header missing from response").toBeTruthy();
  return Number(value);
}

async function assertGuardSemantics(
  page: Page,
  base: (path: string) => string,
) {
  // Document load: middleware ran, outer layout rendered its stamp.
  const docResponse = await page.goto(base("/client-shop"));
  const docMw = mwHeader(docResponse!.headers());
  await waitForHydration(page);
  const stamp = await outerStamp(page);

  // Within-group navigation (prefetch="none" link, so the canonical partial
  // request is observable): middleware ran AGAIN; outer layout held.
  const navResponse = page.waitForResponse(
    (r) => r.url().includes("/client-shop/ssr/") && r.status() === 200,
  );
  await page.click('[data-testid="client-shop-ssr-link"]');
  const navMw = mwHeader((await navResponse).headers());
  expect(navMw).toBeGreaterThan(docMw);
  await expect(
    page.locator('[data-testid="client-shop-ssr-name"]'),
  ).toContainText("Wireless Headphones", { timeout: 10000 });
  expect(await outerStamp(page)).toBe(stamp);
}

async function assertHeldTabSwitchRoundTrips(
  page: Page,
  base: (path: string) => string,
) {
  await page.goto(base("/client-shop/product/wireless-headphones"));
  await waitForHydration(page);
  await expect(page.locator('[data-testid="client-shop-name"]')).toContainText(
    "Wireless Headphones",
    { timeout: 15000 },
  );
  const stamp = await outerStamp(page);

  // Tab switch: the product/related loaders HOLD (param-sensitive
  // revalidate() predicates — the decision crosses on the request), but the
  // canonical request still happens and middleware wraps it.
  const tabResponse = page.waitForResponse(
    (r) => r.url().includes("tab=reviews") && r.status() === 200,
  );
  await page.click('[data-testid="client-shop-tab-reviews"]');
  const tabMw = mwHeader((await tabResponse).headers());
  expect(tabMw).toBeGreaterThan(0);
  await expect(
    page.locator('[data-testid="client-shop-tab-panel-reviews"]'),
  ).toBeVisible({ timeout: 10000 });
  // Held data: the product name is still rendered without a refetch skeleton.
  await expect(page.locator('[data-testid="client-shop-name"]')).toContainText(
    "Wireless Headphones",
  );
  expect(await outerStamp(page)).toBe(stamp);
}

devTest.describe("client-shop outer guards", () => {
  devTest(
    "middleware re-runs on within-group navigation while the outer layout holds",
    async ({ page, devServerURL }) => {
      await assertGuardSemantics(page, (p) => devURL(devServerURL, p));
    },
  );

  devTest(
    "a held-loader tab switch still round-trips through middleware",
    async ({ page, devServerURL }) => {
      await assertHeldTabSwitchRoundTrips(page, (p) => devURL(devServerURL, p));
    },
  );
});

prodDescribe("client-shop outer guards", (f) => {
  test("middleware re-runs on within-group navigation while the outer layout holds", async ({
    page,
  }) => {
    await assertGuardSemantics(page, (p) => f.url(p));
  });

  test("a held-loader tab switch still round-trips through middleware", async ({
    page,
  }) => {
    await assertHeldTabSwitchRoundTrips(page, (p) => f.url(p));
  });
});
