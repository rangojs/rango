import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError, goBack, testId } from "./helper";

/**
 * Shop intercept route tests - background preservation during action revalidation
 */
test.describe("shop-intercept-background-preservation", () => {
  const f = useFixture({
    root: ".",
    mode: "dev",
  });

  test("should preserve background data when action completes after navigating back to intercept", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // Step 1: Navigate to shop page
    await page.goto(f.url("/shop"));
    await waitForHydration(page);

    // Verify shop page shows product grid
    await expect(page.locator("text=All Products")).toBeVisible();
    await expect(page.locator("text=Featured Products")).toBeVisible();

    // Step 2: Click on a product to open intercept modal
    // Click on the product link (the card in the product grid)
    await page.locator('a[href="/shop/product/wireless-headphones"]').first().click();
    await expect(page).toHaveURL(/\/shop\/product\/wireless-headphones/);

    // Modal should be visible with "Intercepted" label
    await expect(page.locator("text=Intercepted")).toBeVisible();

    // Background should still show product grid
    await expect(page.locator("text=Featured Products")).toBeVisible();

    // Step 3: Click "View Full Details" to go to full product page (non-intercept)
    await page.locator("text=View Full Details").click();
    await page.waitForTimeout(500); // Wait for navigation

    // Should no longer be intercepted - "Intercepted" label should be gone
    await expect(page.locator("text=Intercepted")).not.toBeVisible();

    // Should be on product detail page (has the revalidation test box)
    await expect(page.locator("text=Test Revalidation Behavior")).toBeVisible();
    await expect(page.locator("text=Add to Cart").first()).toBeVisible();

    // Step 4: Click "Add to Cart" to trigger action (has ~3s delay)
    const addToCartButton = page
      .locator("button")
      .filter({ hasText: "Add to Cart (useActionState)" })
      .first();
    await addToCartButton.click();

    // Wait a bit for action to start on server but not complete
    await page.waitForTimeout(300);

    // Step 5: Navigate back to intercept modal
    await goBack(page);

    // Should be back on intercept modal
    await expect(page.locator("text=Intercepted")).toBeVisible();

    // Background should be visible immediately (from cache)
    await expect(page.locator("text=Featured Products")).toBeVisible();

    // Step 6: Wait for action to complete and background revalidation
    // The action has ~3s delay, so wait 5s to be safe
    await page.waitForTimeout(5000);

    // CRITICAL: Background should STILL be visible after revalidation
    // This is the bug - background was disappearing after revalidation
    await expect(page.locator("text=Featured Products")).toBeVisible({
      timeout: 2000,
    });

    // Modal should still be visible
    await expect(page.locator("text=Intercepted")).toBeVisible();
  });
});

/**
 * Shop navigation tests
 */
test.describe("shop-navigation", () => {
  const f = useFixture({
    root: ".",
    mode: "dev",
  });

  test("should display shop index with products", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/shop"));
    await waitForHydration(page);

    // Shop index should show products
    await expect(page.locator("text=All Products")).toBeVisible();
    await expect(page.locator("text=Featured Products")).toBeVisible();

    // Product links should be visible
    await expect(
      page.locator('a[href="/shop/product/wireless-headphones"]').first()
    ).toBeVisible();
  });

  test("should show intercept modal with loading skeleton when clicking product", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/shop"));
    await waitForHydration(page);

    // Click on a product
    await page
      .locator('a[href="/shop/product/wireless-headphones"]')
      .first()
      .click();

    // Modal loading skeleton should appear briefly (has shimmer animation)
    // The modal wrapper should be visible
    await expect(page.locator("text=Intercepted")).toBeVisible({ timeout: 3000 });

    // Background should remain visible
    await expect(page.locator("text=Featured Products")).toBeVisible();
  });

  test("should NOT show loading skeleton on direct navigation (SSR)", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // Direct navigation to product page (hard navigation / SSR)
    await page.goto(f.url("/shop/product/wireless-headphones"));
    await waitForHydration(page);

    // Should show product content directly (no skeleton for SSR)
    // The product detail has a 1s artificial delay but loading(skeleton, true)
    // means skeleton is only shown for client-side navigation, not SSR
    await expect(page.locator("h2:has-text('Wireless Headphones')")).toBeVisible({
      timeout: 5000,
    });

    // Should NOT be intercepted on direct navigation
    await expect(page.locator("text=Intercepted")).not.toBeVisible();
  });

  test("should close intercept modal on back navigation", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/shop"));
    await waitForHydration(page);

    // Open modal
    await page
      .locator('a[href="/shop/product/wireless-headphones"]')
      .first()
      .click();
    await expect(page.locator("text=Intercepted")).toBeVisible({ timeout: 3000 });

    // Navigate back
    await goBack(page);

    // Modal should be closed
    await expect(page.locator("text=Intercepted")).not.toBeVisible();

    // Shop page should be restored
    await expect(page.locator("text=All Products")).toBeVisible();
    await expect(page.locator("text=Featured Products")).toBeVisible();
  });

  test("should navigate from intercept modal to full product page", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/shop"));
    await waitForHydration(page);

    // Open modal
    await page
      .locator('a[href="/shop/product/wireless-headphones"]')
      .first()
      .click();
    await expect(page.locator("text=Intercepted")).toBeVisible({ timeout: 3000 });

    // Click View Full Details
    await page.locator("text=View Full Details").click();

    // Should navigate to full product page
    await expect(page.locator("text=Intercepted")).not.toBeVisible({
      timeout: 3000,
    });

    // Full product page content should be visible
    await expect(
      page.locator("text=Test Revalidation Behavior")
    ).toBeVisible({ timeout: 3000 });
  });
});

/**
 * Shop actions tests
 */
test.describe("shop-actions", () => {
  const f = useFixture({
    root: ".",
    mode: "dev",
  });

  test("should add product to cart from product detail page", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/shop/product/wireless-headphones"));
    await waitForHydration(page);

    // Wait for product to load (has 1s artificial delay + loading time)
    await expect(
      page.locator("h2:has-text('Wireless Headphones')")
    ).toBeVisible({
      timeout: 10000,
    });

    // Wait for the add to cart section to be visible
    await expect(page.locator("text=Add to Cart - Tests")).toBeVisible({
      timeout: 5000,
    });

    // Click first add to cart button (Fire & Forget section)
    // All buttons have text "Add to Cart (useActionState)"
    const addToCartButton = page
      .locator("button")
      .filter({ hasText: "Add to Cart (useActionState)" })
      .first();
    await addToCartButton.click();

    // Wait for action to process
    await page.waitForTimeout(2000);

    // Page should still be functional
    await expect(
      page.locator("h2:has-text('Wireless Headphones')")
    ).toBeVisible();
  });

  test("should show streaming action updates", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/shop/product/wireless-headphones"));
    await waitForHydration(page);

    // Wait for product to load
    await expect(
      page.locator("h2:has-text('Wireless Headphones')")
    ).toBeVisible({
      timeout: 10000,
    });

    // Wait for the add to cart section to be visible
    await expect(page.locator("text=Add to Cart - Tests")).toBeVisible({
      timeout: 5000,
    });

    // Click streaming add to cart button
    const streamingButton = page
      .locator("button")
      .filter({ hasText: "Add product (Streaming)" })
      .first();
    await streamingButton.click();

    // Wait for streaming action to complete (has 3s delay)
    await page.waitForTimeout(4000);

    // Page should still be functional
    await expect(
      page.locator("h2:has-text('Wireless Headphones')")
    ).toBeVisible();
  });

  test("should update cart quantity from intercept modal", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/shop"));
    await waitForHydration(page);

    // Open modal
    await page
      .locator('a[href="/shop/product/wireless-headphones"]')
      .first()
      .click();
    await expect(page.locator("text=Intercepted")).toBeVisible({
      timeout: 5000,
    });

    // Modal has "+" button to increase quantity
    const plusButton = page.locator("button").filter({ hasText: "+" }).first();
    await plusButton.click();

    // Wait for action to complete
    await page.waitForTimeout(2000);

    // Modal should still be visible
    await expect(page.locator("text=Intercepted")).toBeVisible();

    // Background should still be visible
    await expect(page.locator("text=Featured Products")).toBeVisible();
  });
});

/**
 * Shop breadcrumb tests - handle data caching through intercept navigation
 */
test.describe("shop-breadcrumbs", () => {
  const f = useFixture({
    root: ".",
    mode: "dev",
  });

  test("should preserve category breadcrumbs after navigating through intercept to detail and back", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // Capture console logs for debugging
    const logs: string[] = [];
    page.on("console", (msg) => {
      if (msg.text().includes("[Browser]") || msg.text().includes("[NavigationProvider]") || msg.text().includes("[Store]")) {
        logs.push(msg.text());
      }
    });

    const breadcrumbNav = page.locator('nav[aria-label="Breadcrumb"]');

    // Step 1: Navigate to shop page
    await page.goto(f.url("/shop"));
    await waitForHydration(page);

    // Verify shop breadcrumb
    await expect(breadcrumbNav.locator("text=Shop")).toBeVisible();

    // Step 2: Navigate to a category page (sidebar only shown on index)
    await page.locator('a[href="/shop/products/electronics"]').first().click();
    await expect(page.locator("h2:has-text('Electronics')")).toBeVisible({ timeout: 5000 });

    // Verify category breadcrumbs: Shop > Electronics
    await expect(breadcrumbNav.locator("text=Shop")).toBeVisible();
    await expect(breadcrumbNav.locator("text=Electronics")).toBeVisible();

    // Step 3: Click on a product to open intercept modal
    await page.locator('a[href="/shop/product/wireless-headphones"]').first().click();
    await expect(page.locator("text=Intercepted")).toBeVisible({ timeout: 5000 });

    // Step 4: Click "View Full Details" to go to full product page
    await page.locator("text=View Full Details").click();
    await expect(page.locator("text=Intercepted")).not.toBeVisible({ timeout: 3000 });
    await expect(page.locator("text=Test Revalidation Behavior")).toBeVisible({ timeout: 5000 });

    // Step 5: Go back - should return to intercept modal
    await goBack(page);
    await expect(page.locator("text=Intercepted")).toBeVisible({ timeout: 3000 });

    // Step 6: Go back again - should return to category page
    await goBack(page);
    await expect(page.locator("text=Intercepted")).not.toBeVisible({ timeout: 3000 });

    // CRITICAL: Category breadcrumbs should be restored: Shop > Electronics
    await expect(breadcrumbNav.locator("text=Shop")).toBeVisible();

    // Print console logs for debugging
    console.log("=== Browser Console Logs ===");
    logs.forEach((log) => console.log(log));
    console.log("=== End Browser Console Logs ===");

    await expect(breadcrumbNav.locator("text=Electronics")).toBeVisible({ timeout: 3000 });
  });

  test("should display correct breadcrumbs on shop index", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/shop"));
    await waitForHydration(page);

    const breadcrumbNav = page.locator('nav[aria-label="Breadcrumb"]');
    await expect(breadcrumbNav.locator("text=Shop")).toBeVisible();
  });

  test("should display category breadcrumbs", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/shop/products/electronics"));
    await waitForHydration(page);

    const breadcrumbNav = page.locator('nav[aria-label="Breadcrumb"]');
    await expect(breadcrumbNav.locator("text=Shop")).toBeVisible();
    await expect(breadcrumbNav.locator("text=Electronics")).toBeVisible();
  });

  test("should display product breadcrumbs on direct navigation", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/shop/product/wireless-headphones"));
    await waitForHydration(page);

    // Wait for product to load
    await expect(page.locator("h2:has-text('Wireless Headphones')")).toBeVisible({ timeout: 10000 });

    const breadcrumbNav = page.locator('nav[aria-label="Breadcrumb"]');
    await expect(breadcrumbNav.locator("text=Shop")).toBeVisible();
    await expect(breadcrumbNav.locator("text=Wireless Headphones")).toBeVisible();
  });

  test("should update breadcrumbs when navigating from shop to product detail", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/shop"));
    await waitForHydration(page);

    const breadcrumbNav = page.locator('nav[aria-label="Breadcrumb"]');

    // Initially only Shop breadcrumb
    await expect(breadcrumbNav.locator("text=Shop")).toBeVisible();

    // Navigate to product via intercept
    await page.locator('a[href="/shop/product/wireless-headphones"]').first().click();
    await expect(page.locator("text=Intercepted")).toBeVisible({ timeout: 5000 });

    // Go to full product page
    await page.locator("text=View Full Details").click();
    await expect(page.locator("text=Intercepted")).not.toBeVisible({ timeout: 3000 });

    // Wait for product page to load
    await expect(page.locator("h2:has-text('Wireless Headphones')")).toBeVisible({ timeout: 10000 });

    // Breadcrumbs should show Shop > Product
    await expect(breadcrumbNav.locator("text=Shop")).toBeVisible();
    await expect(breadcrumbNav.locator("text=Wireless Headphones")).toBeVisible();
  });

  test("should restore breadcrumbs on simple back navigation from product to shop", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/shop"));
    await waitForHydration(page);

    const breadcrumbNav = page.locator('nav[aria-label="Breadcrumb"]');

    // Navigate to product via intercept
    await page.locator('a[href="/shop/product/wireless-headphones"]').first().click();
    await expect(page.locator("text=Intercepted")).toBeVisible({ timeout: 5000 });

    // Go back to shop
    await goBack(page);
    await expect(page.locator("text=Intercepted")).not.toBeVisible({ timeout: 3000 });

    // Shop breadcrumb should be restored, no product breadcrumb
    await expect(breadcrumbNav.locator("text=Shop")).toBeVisible();
    await expect(breadcrumbNav.locator("text=Wireless Headphones")).not.toBeVisible();
  });
});

/**
 * Shop concurrent actions tests
 */
test.describe("shop-concurrent-actions", () => {
  const f = useFixture({
    root: ".",
    mode: "dev",
  });

  test("should handle rapid quantity changes from modal", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/shop"));
    await waitForHydration(page);

    // Open product modal
    await page
      .locator('a[href="/shop/product/wireless-headphones"]')
      .first()
      .click();
    await expect(page.locator("text=Intercepted")).toBeVisible({
      timeout: 5000,
    });

    // First click "Add to Cart" to add item to cart
    const addToCartButton = page.locator("button").filter({ hasText: "Add to Cart" }).first();
    await addToCartButton.click();

    // Wait for UI to update to show quantity controls
    await expect(page.locator("button").filter({ hasText: "+" }).first()).toBeVisible({
      timeout: 5000,
    });

    // Now click + button multiple times rapidly to increase quantity
    const plusButton = page.locator("button").filter({ hasText: "+" }).first();
    await plusButton.click();
    await plusButton.click();
    await plusButton.click();

    // Wait for all actions to complete
    await page.waitForTimeout(4000);

    // Modal should still be visible and functional
    await expect(page.locator("text=Intercepted")).toBeVisible();

    // Background should still be visible
    await expect(page.locator("text=Featured Products")).toBeVisible();
  });

  test("should handle concurrent add to cart actions from detail page", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/shop/product/wireless-headphones"));
    await waitForHydration(page);

    // Wait for product to load
    await expect(
      page.locator("h2:has-text('Wireless Headphones')")
    ).toBeVisible({
      timeout: 10000,
    });

    // Wait for the add to cart section to be visible
    await expect(page.locator("text=Add to Cart - Tests")).toBeVisible({
      timeout: 5000,
    });

    // Find both add to cart buttons
    const useActionStateButton = page
      .locator("button")
      .filter({ hasText: "Add to Cart (useActionState)" })
      .first();

    const streamingButton = page
      .locator("button")
      .filter({ hasText: "Add product (Streaming)" })
      .first();

    // Click both buttons in quick succession (concurrent actions)
    await useActionStateButton.click();
    await streamingButton.click();

    // Wait for both actions to complete (streaming has 3s delay)
    await page.waitForTimeout(5000);

    // Page should still be functional
    await expect(
      page.locator("h2:has-text('Wireless Headphones')")
    ).toBeVisible();
  });

  test("should handle action during modal navigation", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/shop"));
    await waitForHydration(page);

    // Open product modal
    await page
      .locator('a[href="/shop/product/wireless-headphones"]')
      .first()
      .click();
    await expect(page.locator("text=Intercepted")).toBeVisible({
      timeout: 5000,
    });

    // Click + to trigger action
    const plusButton = page.locator("button").filter({ hasText: "+" }).first();
    await plusButton.click();

    // Immediately navigate away before action completes
    await goBack(page);

    // Wait for navigation
    await page.waitForTimeout(1000);

    // Should be back on shop page
    await expect(page.locator("text=All Products")).toBeVisible();
    await expect(page.locator("text=Featured Products")).toBeVisible();

    // Page should be functional
    await expect(page.locator("text=Intercepted")).not.toBeVisible();
  });
});
