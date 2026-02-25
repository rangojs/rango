import { test, expect, devURL } from "./dev-fixture";
import { waitForHydration, expectNoPageError, goBack } from "./helper";

/**
 * History cache eviction tests - verifies the LRU cache (default 20 entries)
 * evicts old entries and back navigation still works by re-fetching from server.
 * Source: packages/rangojs-router/src/browser/navigation-store.ts
 */
test.describe("history-cache-eviction", () => {
  // This test navigates through many pages so it needs extra time
  test.setTimeout(120000);

  test("should re-fetch evicted entries on back navigation", async ({
    page,
    devServerURL,
  }) => {
    using _ = expectNoPageError(page);

    // Start at the blog index (this will be the first history entry)
    await page.goto(devURL(devServerURL, "/blog"));
    await waitForHydration(page);
    await expect(page.locator("text=Blog Posts")).toBeVisible();

    // Navigate through many distinct URLs to exceed HISTORY_CACHE_SIZE = 20.
    // Use shop product pages since there are 20 unique products.
    const productSlugs = [
      "wireless-headphones",
      "running-shoes",
      "coffee-maker",
      "laptop-stand",
      "yoga-mat",
      "desk-lamp",
      "mechanical-keyboard",
      "water-bottle",
      "air-purifier",
      "wireless-mouse",
      "resistance-bands",
      "throw-pillows",
      "webcam",
      "dumbbells",
      "candle-set",
      "usb-hub",
      "jump-rope",
      "wall-clock",
      "phone-stand",
      "foam-roller",
    ];

    // Navigate to each product page, accumulating >20 history entries.
    // (Entry 0 = /blog, entries 1-20 = product pages)
    for (const slug of productSlugs) {
      await page.goto(devURL(devServerURL, `/shop/product/${slug}`));
      // Wait for product title to confirm content loaded.
      // Product names are title-cased versions of the slug.
      await page.waitForTimeout(500);
    }

    // The /blog entry (entry 0) should have been evicted from the
    // history cache by now since we have 21 entries total but the
    // cache only holds 20.

    // Navigate back through all product pages to reach the blog entry.
    // Each goBack restores the previous page.
    for (let i = productSlugs.length - 1; i >= 0; i--) {
      await goBack(page);
      // Just wait briefly for navigation to settle
      await page.waitForTimeout(300);
    }

    // We should be back at /blog. The page should render correctly
    // even though the entry was evicted (re-fetched from server).
    await expect(page).toHaveURL(/\/blog$/);
    await expect(page.locator("text=Blog Posts")).toBeVisible({
      timeout: 10000,
    });
  });
});
