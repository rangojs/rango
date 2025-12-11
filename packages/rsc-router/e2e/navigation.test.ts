import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import {
  waitForHydration,
  expectNoPageError,
  goBack,
  getHistoryState,
} from "./helper";

/**
 * Navigation tests using demo app
 * Tests intercept navigation, cache consistency, and stale revalidation
 */
test.describe("intercept-navigation", () => {
  const f = useFixture({
    root: "../../examples/vite-rsc-demo",
    mode: "dev",
  });

  test("should show modal when clicking product from shop index", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/shop"));
    await waitForHydration(page);

    // Click first product link - shop uses ProductCard components
    const productLink = page.locator('a[href*="/shop/product/"]').first();
    await productLink.click();

    // Should show modal with product content
    // Modal uses position: fixed overlay
    await expect(page.locator('div[style*="position: fixed"]')).toBeVisible();

    // URL should change to product URL
    await expect(page).toHaveURL(/\/shop\/product\//);
  });

  test("should preserve background when navigating back from modal", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/shop"));
    await waitForHydration(page);

    // Click product to open modal
    const productLink = page.locator('a[href*="/shop/product/"]').first();
    await productLink.click();
    await expect(page.locator('div[style*="position: fixed"]')).toBeVisible();

    // Navigate back
    await goBack(page);

    // Should be back on shop index
    await expect(page).toHaveURL(/\/shop\/?$/);

    // Modal should be gone (no fixed position element)
    await expect(page.locator('div[style*="position: fixed"][style*="inset: 0"]')).not.toBeVisible();
  });

  test("should navigate to full product page via View Full Details", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/shop"));
    await waitForHydration(page);

    // Open product modal
    const productLink = page.locator('a[href*="/shop/product/"]').first();
    await productLink.click();
    await expect(page.locator('div[style*="position: fixed"]')).toBeVisible();

    // Click View Full Details link inside modal
    await page.locator('text=View Full Details').click();

    // Should navigate to full product detail page (not intercepted)
    await page.waitForURL(/\/shop\/product\//);

    // Modal overlay should be gone
    await expect(page.locator('div[style*="position: fixed"][style*="inset: 0"]')).not.toBeVisible();

    // Product detail should show segment metadata
    await expect(page.locator('text=Segment Metadata')).toBeVisible();
  });

  test("should show full product page on direct navigation", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // Navigate directly to product URL (use real product slug)
    await page.goto(f.url("/shop/product/wireless-headphones"));
    await waitForHydration(page);

    // Should NOT show intercepted modal (no fixed overlay)
    await expect(page.locator('div[style*="position: fixed"][style*="inset: 0"]')).not.toBeVisible();

    // Should show full product detail page with segment metadata
    await expect(page.locator('text=Segment Metadata')).toBeVisible();
  });

  test("should maintain intercept state in history", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/shop"));
    await waitForHydration(page);

    // Open product modal (intercept)
    const productLink = page.locator('a[href*="/shop/product/"]').first();
    await productLink.click();
    await expect(page.locator('div[style*="position: fixed"]')).toBeVisible();

    // Check history state has intercept flag
    const state = await getHistoryState(page);
    expect(state?.intercept).toBe(true);
  });
});

test.describe("action-cache-consistency", () => {
  const f = useFixture({
    root: "../../examples/vite-rsc-demo",
    mode: "dev",
  });

  test("should preserve background when action completes after navigating back", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/shop"));
    await waitForHydration(page);

    // Open product modal
    const productLink = page.locator('a[href*="/shop/product/"]').first();
    await productLink.click();
    await expect(page.locator('div[style*="position: fixed"]')).toBeVisible();

    // Click add to cart button (starts action)
    const addToCartButton = page.locator('button:has-text("Add to Cart")').first();
    if (await addToCartButton.isVisible()) {
      await addToCartButton.click();

      // Immediately navigate back before action completes
      await goBack(page);

      // Wait for stale responses
      await page.waitForTimeout(600);

      // Index content should still be visible
      await expect(page.locator('text=All Products')).toBeVisible();

      // Modal should be gone
      await expect(page.locator('div[style*="position: fixed"][style*="inset: 0"]')).not.toBeVisible();
    }
  });

  test("should not corrupt cache when navigating from intercept to detail during action", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/shop"));
    await waitForHydration(page);

    // Open product modal (intercept)
    const productLink = page.locator('a[href*="/shop/product/"]').first();
    await productLink.click();
    await expect(page.locator('div[style*="position: fixed"]')).toBeVisible();

    // Click View Full Details
    await page.locator('text=View Full Details').click();
    await expect(page.locator('text=Segment Metadata')).toBeVisible();

    // Start action on detail page
    const addToCartButton = page.locator('button:has-text("Add to Cart")').first();
    if (await addToCartButton.isVisible()) {
      await addToCartButton.click();

      // Navigate back while action is in progress
      await goBack(page);

      // Wait for stale responses
      await page.waitForTimeout(600);

      // Should be back on intercepted view (modal)
      await expect(page.locator('div[style*="position: fixed"]')).toBeVisible();

      // Background should still be visible
      await expect(page.locator('text=All Products')).toBeVisible();
    }
  });
});

test.describe("stale-revalidation", () => {
  const f = useFixture({
    root: "../../examples/vite-rsc-demo",
    mode: "dev",
  });

  test("should restore from cache on back navigation", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/shop"));
    await waitForHydration(page);

    // Navigate to product via link
    const productLink = page.locator('a[href*="/shop/product/"]').first();
    await productLink.click();
    await expect(page.locator('div[style*="position: fixed"]')).toBeVisible();

    // Click View Full Details
    await page.locator('text=View Full Details').click();
    await expect(page.locator('text=Segment Metadata')).toBeVisible();

    // Navigate back twice (to index)
    await goBack(page); // Back to intercept
    await goBack(page); // Back to index

    // Index should be restored immediately from cache
    await expect(page.locator('text=All Products')).toBeVisible();
  });

  test("should preserve intercept segments during stale revalidation", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/shop"));
    await waitForHydration(page);

    // Open product modal
    const productLink = page.locator('a[href*="/shop/product/"]').first();
    await productLink.click();
    await expect(page.locator('div[style*="position: fixed"]')).toBeVisible();

    // Store that we can see background
    await expect(page.locator('text=All Products')).toBeVisible();

    // Navigate back to close modal
    await goBack(page);
    await expect(page.locator('div[style*="position: fixed"][style*="inset: 0"]')).not.toBeVisible();

    // Navigate to cart (use specific link selector)
    await page.locator('a[href="/shop/cart"]').click();
    await expect(page).toHaveURL(/\/shop\/cart$/);

    // Navigate back to shop
    await goBack(page);

    // Shop content should be restored
    await expect(page.locator('text=All Products')).toBeVisible();
  });
});
