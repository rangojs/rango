import { expect, test } from "@playwright/test";
import { test as devTest, devURL } from "./dev-fixture";
import { prodDescribe, waitForHydration, expectNoPageError } from "./helper";

/**
 * The originally-reported case for the floored "new-segment" seed: /shop's
 * category sidebar is a route-scoped slot that opts out of revalidation
 * (src/urls/shop.tsx), so landing on /shop/product/:slug and soft-navigating to
 * /shop left it permanently blank while a direct load rendered it fine.
 *
 * Unlike the reduced fixtures in the router test-app and cloudflare-basic, this
 * drives real app routes with many sibling segments. Mechanism and fix live in
 * the router's segment-resolution/revalidation.ts.
 */

const SIDEBAR = "text=Segment: @sidebar";
const PRODUCT = "water-bottle";

/**
 * Assert the sidebar renders on a direct load of /shop (control), then that it
 * survives the reported path: land on a PDP, soft-nav to /shop.
 */
async function assertSidebarAfterSoftNavFromPdp(
  page: import("@playwright/test").Page,
  url: (path: string) => string,
) {
  // Control: a document request to /shop renders the slot. If this fails the
  // fixture itself is broken, not the soft-nav path.
  await page.goto(url("/shop"));
  await waitForHydration(page);
  await expect(page.locator(SIDEBAR)).toBeVisible();

  // The reported path: land on the product detail page first. It has no
  // @sidebar, so the slot is absent from the client's segment set.
  await page.goto(url(`/shop/product/${PRODUCT}`));
  await waitForHydration(page);
  await expect(page.locator("text=Add to Cart").first()).toBeVisible();
  await expect(page.locator(SIDEBAR)).toHaveCount(0);

  // Soft-navigate to /shop.
  await page.locator('a[href="/shop"]').first().click();
  await page.waitForURL(/\/shop$/);
  await expect(page.locator("text=All Products")).toBeVisible();

  // The sidebar must be there — pre-fix it stayed blank forever.
  await expect(page.locator(SIDEBAR)).toBeVisible();
  await expect(page.locator("text=Categories")).toBeVisible();
}

// ---------- DEV ----------
devTest.describe("shop-sidebar-new-slot", () => {
  devTest(
    "renders the @sidebar slot on soft nav from a product page that never had it",
    async ({ page, devServerURL }) => {
      using _ = expectNoPageError(page);
      await assertSidebarAfterSoftNavFromPdp(page, (p) =>
        devURL(devServerURL, p),
      );
    },
  );
});

// ---------- PRODUCTION ----------
prodDescribe("shop-sidebar-new-slot", (f) => {
  test("renders the @sidebar slot on soft nav from a product page that never had it", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await assertSidebarAfterSoftNavFromPdp(page, (p) => f.url(p));
  });
});
