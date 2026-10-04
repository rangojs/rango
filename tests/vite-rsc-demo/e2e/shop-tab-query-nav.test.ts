import { expect, test, type Page } from "@playwright/test";
import { test as devTest, devURL } from "./dev-fixture";
import {
  prodDescribe,
  waitForHydration,
  expectNoPageError,
  expectNoReload,
} from "./helper";

/**
 * Query-only PDP navigation (?tab=) must not flash the route skeleton.
 *
 * The @related slot is the only PDP segment revalidating on a query change
 * (belongsToRoute default); with no loading() of its own, its refresh
 * suspends at the route's loading(<ProductDetailSkeleton/>) and blanks the
 * whole page for a few frames. Fix: the slot shares the route's named
 * predicate (productDetailRevalidation) in src/urls/shop.tsx, so a query-only
 * change revalidates nothing.
 *
 * The second test pins the failure mode of the tempting-but-wrong fix: a bare
 * revalidate(() => false) on the slot would keep the PREVIOUS product's
 * related list on slug-change navigation.
 */

const PDP = "/shop/product/running-shoes";

/** Arm a MutationObserver counting mounts of skeleton (shimmer) nodes. */
async function armSkeletonSentinel(page: Page) {
  await page.evaluate(() => {
    (window as unknown as { __skeletonMounts: number }).__skeletonMounts = 0;
    const bump = () =>
      (window as unknown as { __skeletonMounts: number }).__skeletonMounts++;
    const mo = new MutationObserver((muts) => {
      for (const m of muts) {
        for (const n of m.addedNodes) {
          if (!(n instanceof HTMLElement)) continue;
          if (
            n.matches('[style*="shimmer"]') ||
            n.querySelector('[style*="shimmer"]')
          ) {
            bump();
          }
        }
      }
    });
    mo.observe(document.body, { childList: true, subtree: true });
  });
}

function skeletonMounts(page: Page): Promise<number> {
  return page.evaluate(
    () => (window as unknown as { __skeletonMounts: number }).__skeletonMounts,
  );
}

async function assertTabNavKeepsPageMounted(page: Page, pdpUrl: string) {
  await page.goto(pdpUrl);
  await waitForHydration(page);
  await expect(page.locator("text=Related Products")).toBeVisible();
  await using _ = await expectNoReload(page);

  // Node-identity sentinel: if the route subtree suspends into its loading()
  // fallback, this node is unmounted and stays disconnected even after
  // content returns — a flash-timing-independent detector.
  const revalBox = await page.evaluateHandle(() => {
    const el = Array.from(document.querySelectorAll("h4")).find((h) =>
      h.textContent?.includes("Test Revalidation Behavior"),
    );
    if (!el) throw new Error("reval box not found");
    return el;
  });
  await armSkeletonSentinel(page);

  await page.locator('a[href$="?tab=details"]').first().click();
  await page.waitForURL(/tab=details/);
  await page.waitForTimeout(600);

  expect(await skeletonMounts(page)).toBe(0);
  expect(await revalBox.evaluate((n) => (n as HTMLElement).isConnected)).toBe(
    true,
  );
  await expect(page.locator("text=Related Products")).toBeVisible();

  // Second query change (tab=details -> tab=reviews) — same contract.
  await page.locator('a[href$="?tab=reviews"]').first().click();
  await page.waitForURL(/tab=reviews/);
  await page.waitForTimeout(600);

  expect(await skeletonMounts(page)).toBe(0);
  expect(await revalBox.evaluate((n) => (n as HTMLElement).isConnected)).toBe(
    true,
  );
}

async function assertSlugChangeRefreshesRelated(page: Page, pdpUrl: string) {
  await page.goto(pdpUrl);
  await waitForHydration(page);

  // running-shoes (sports) -> related shows Yoga Mat.
  await expect(page.locator("text=Yoga Mat").first()).toBeVisible();

  // Slug change via the reval box link. The route + slot revalidate together
  // (shared predicate) — related must switch to the electronics list.
  await page
    .locator('a[href="/shop/product/wireless-headphones"]')
    .first()
    .click();
  await page.waitForURL(/wireless-headphones/);
  await expect(page.locator("text=Laptop Stand").first()).toBeVisible({
    timeout: 10000,
  });
  await expect(page.locator("text=Yoga Mat")).toHaveCount(0);
}

// ---------- DEV ----------
devTest.describe("shop-tab-query-nav", () => {
  devTest(
    "?tab= navigation keeps the page mounted with zero skeleton frames",
    async ({ page, devServerURL }) => {
      using _ = expectNoPageError(page);
      await assertTabNavKeepsPageMounted(page, devURL(devServerURL, PDP));
    },
  );

  devTest(
    "slug change still refreshes @related (no stale related list)",
    async ({ page, devServerURL }) => {
      using _ = expectNoPageError(page);
      await assertSlugChangeRefreshesRelated(page, devURL(devServerURL, PDP));
    },
  );
});

// ---------- PRODUCTION ----------
prodDescribe("shop-tab-query-nav", (f) => {
  test("?tab= navigation keeps the page mounted with zero skeleton frames", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await assertTabNavKeepsPageMounted(page, f.url(PDP));
  });

  test("slug change still refreshes @related (no stale related list)", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await assertSlugChangeRefreshesRelated(page, f.url(PDP));
  });
});
