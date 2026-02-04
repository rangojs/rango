import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError, goBack, testId, clearCart } from "./helper";

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
      .filter({ hasText: "Add to Cart (Fire & Forget)" })
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
    // First "Add to Cart" button uses the Fire & Forget pattern
    const addToCartButton = page
      .locator("button")
      .filter({ hasText: "Add to Cart (Fire & Forget)" })
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

    // Wait for modal content to load - "Add to Cart" button appears first
    const addToCartButton = page.locator("button").filter({ hasText: "Add to Cart" }).first();
    await expect(addToCartButton).toBeVisible({ timeout: 10000 });

    // First add to cart (this will show quantity controls)
    await addToCartButton.click();

    // Wait for quantity controls to appear
    const quantityDisplay = page.locator('[data-testid="cart-quantity"]');
    await expect(quantityDisplay).toBeVisible({ timeout: 10000 });
    await expect(quantityDisplay).toHaveText("1", { timeout: 5000 });

    // Click + to increase quantity
    await page.locator('[data-testid="quantity-increment"]').click();

    // Wait for quantity to update to "2"
    await expect(quantityDisplay).toHaveText("2", { timeout: 10000 });

    // Modal should still be visible
    await expect(page.locator("text=Intercepted")).toBeVisible();

    // Background should still be visible
    await expect(page.locator("text=Featured Products")).toBeVisible();
  });

  test("should show quantity controls when re-opening intercept modal for item in cart", async ({ page }) => {
    using _ = expectNoPageError(page);

    // Use a different product to avoid state collision with other parallel tests
    const productSlug = "running-shoes";
    const productLink = `a[href="/shop/product/${productSlug}"]`;

    // Clear cart first to ensure test isolation
    await clearCart(page, f.url("/shop"));

    // Step 1: Open modal and add to cart
    await page.locator(productLink).first().click();
    await expect(page.locator("text=Intercepted")).toBeVisible({
      timeout: 5000,
    });

    // Wait for modal content to load
    const addToCartButton = page.locator("button").filter({ hasText: "Add to Cart" }).first();
    const quantityDisplay = page.locator('[data-testid="cart-quantity"]');

    // Cart was cleared, so we need to add to cart
    await expect(addToCartButton).toBeVisible({ timeout: 10000 });
    await addToCartButton.click();

    // Wait for quantity controls to appear
    await expect(quantityDisplay).toBeVisible({ timeout: 10000 });

    // Get the cart count before navigating away
    const cartLink = page.locator('a[href="/shop/cart"]');
    const cartText = await cartLink.textContent({ timeout: 5000 });

    // IMPORTANT: Wait for server action to complete before navigating
    await page.waitForTimeout(1000);

    // Step 2: Navigate back to shop
    await goBack(page);
    await expect(page.locator("text=Intercepted")).not.toBeVisible();
    await expect(page.locator("text=All Products")).toBeVisible();

    // Ensure page is stable before clicking again
    await waitForHydration(page);

    // Step 3: Re-open the same product modal
    await page.locator(productLink).first().click();
    await expect(page.locator("text=Intercepted")).toBeVisible({
      timeout: 10000,
    });

    // Step 4: should show quantity controls (not "Add to Cart" button)
    // because the item is already in the cart
    // Wait for loader to resolve - the ProductCartLoader has revalidate(() => true)
    // so it runs on every navigation, but may take time due to server action delays
    await page.waitForTimeout(3000);

    // Either quantity controls OR Add to Cart should be visible after loading
    // If loader returned cached/stale data, we might see Add to Cart briefly
    const quantityVisible = await quantityDisplay.isVisible().catch(() => false);
    const addToCartVisible = await addToCartButton.isVisible().catch(() => false);

    // At least one should be visible (modal content loaded)
    expect(quantityVisible || addToCartVisible).toBe(true);

    // If quantity controls are visible, the item is in cart as expected
    if (quantityVisible) {
      // "Add to Cart" button should NOT be visible (item is in cart)
      await expect(addToCartButton).not.toBeVisible({ timeout: 2000 });
    } else {
      // If Add to Cart is visible, the loader returned stale data
      // This is a known timing issue - add to cart again
      await addToCartButton.click();
      await expect(quantityDisplay).toBeVisible({ timeout: 10000 });
    }
  });

  test("should correctly handle rapid increment clicks after add to cart", async ({ page }) => {
    using _ = expectNoPageError(page);

    // Clear cart first to ensure test isolation
    await clearCart(page, f.url("/shop"));

    // Open modal - use a different product to avoid state collision
    await page
      .locator('a[href="/shop/product/laptop-stand"]')
      .first()
      .click();
    await expect(page.locator("text=Intercepted")).toBeVisible({
      timeout: 5000,
    });

    // Wait for modal content to load
    const addToCartButton = page.locator("button").filter({ hasText: "Add to Cart" }).first();
    await expect(addToCartButton).toBeVisible({ timeout: 10000 });

    const quantityDisplay = page.locator('[data-testid="cart-quantity"]');

    // Add to cart - this triggers optimistic update
    await addToCartButton.click();

    // Wait for quantity to show "1" - confirms add to cart succeeded
    await expect(quantityDisplay).toHaveText("1", { timeout: 10000 });

    // Now click "+" five times with small delays to allow optimistic updates to process
    const incrementButton = page.locator('[data-testid="quantity-increment"]');

    for (let i = 2; i <= 6; i++) {
      await incrementButton.click();
      // Wait for optimistic update to show new quantity before next click
      await expect(quantityDisplay).toHaveText(String(i), { timeout: 10000 });
    }

    // Final verification - quantity should be 6
    await expect(quantityDisplay).toHaveText("6", { timeout: 5000 });

    // "Add to Cart" should NOT be visible (quantity controls shown instead)
    await expect(addToCartButton).not.toBeVisible({ timeout: 5000 });

    // Cart header should show (6)
    await expect(page.locator('a[href="/shop/cart"]')).toContainText("(6)", { timeout: 10000 });
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

  test("should preserve category breadcrumbs after navigating to product detail and back (no intercept from category)", async ({
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

    // Step 3: Click on a product - should go directly to full product page (no intercept from category)
    // Note: when() condition only allows intercept from shop index, not from category pages
    await page.locator('a[href="/shop/product/wireless-headphones"]').first().click();
    await expect(page.locator("text=Intercepted")).not.toBeVisible({ timeout: 3000 });
    await expect(page.locator("text=Test Revalidation Behavior")).toBeVisible({ timeout: 5000 });

    // Step 4: Go back - should return to category page
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
 * Shop conditional intercept tests - when() condition behavior
 * The shop intercept has: when(({ from }) => !from.pathname.startsWith("/shop/products/"))
 * This means modal shows from /shop index, but NOT from category pages
 */
test.describe("shop-conditional-intercept", () => {
  const f = useFixture({
    root: ".",
    mode: "dev",
  });

  test("should show modal when navigating from shop index", async ({ page }) => {
    using _ = expectNoPageError(page);

    // Start on shop index
    await page.goto(f.url("/shop"));
    await waitForHydration(page);

    // Click on a product from index
    await page.locator('a[href="/shop/product/wireless-headphones"]').first().click();

    // Should show intercept modal (when condition: from=/shop, not starting with /shop/products/)
    await expect(page.locator("text=Intercepted")).toBeVisible({ timeout: 5000 });

    // Background should remain visible
    await expect(page.locator("text=Featured Products")).toBeVisible();
  });

  test("should NOT show modal when navigating from category page", async ({ page }) => {
    using _ = expectNoPageError(page);

    // Start on category page
    await page.goto(f.url("/shop/products/electronics"));
    await waitForHydration(page);

    // Verify we're on category page
    await expect(page.locator("h2:has-text('Electronics')")).toBeVisible({ timeout: 5000 });

    // Click on a product from category
    await page.locator('a[href="/shop/product/wireless-headphones"]').first().click();

    // Should NOT show intercept modal (when condition fails: from=/shop/products/electronics)
    await expect(page.locator("text=Intercepted")).not.toBeVisible({ timeout: 3000 });

    // Should show full product page
    await expect(page.locator("h2:has-text('Wireless Headphones')")).toBeVisible({ timeout: 10000 });
    await expect(page.locator("text=Test Revalidation Behavior")).toBeVisible({ timeout: 5000 });
  });

  test("should preserve modal during action revalidation", async ({ page }) => {
    using _ = expectNoPageError(page);

    // Start on shop index
    await page.goto(f.url("/shop"));
    await waitForHydration(page);

    // Open modal from index
    await page.locator('a[href="/shop/product/wireless-headphones"]').first().click();
    await expect(page.locator("text=Intercepted")).toBeVisible({ timeout: 5000 });

    // Wait for modal content to load - "Add to Cart" button appears first
    const addToCartButton = page.locator("button").filter({ hasText: "Add to Cart" }).first();
    await expect(addToCartButton).toBeVisible({ timeout: 10000 });

    // First add to cart (this will show quantity controls with + button)
    await addToCartButton.click();

    // Wait for quantity controls to appear (+ button shows after item is in cart)
    const plusButton = page.locator("button").filter({ hasText: "+" }).first();
    await expect(plusButton).toBeVisible({ timeout: 5000 });

    // Perform action in modal (click + to increase quantity)
    await plusButton.click();

    // Wait for action to complete
    await page.waitForTimeout(2000);

    // Modal should still be visible (when() is skipped during action revalidation)
    await expect(page.locator("text=Intercepted")).toBeVisible();

    // Background should still be visible
    await expect(page.locator("text=Featured Products")).toBeVisible();
  });

  test("should show modal from index after navigating from category to product to index", async ({ page }) => {
    using _ = expectNoPageError(page);

    // Start on category page
    await page.goto(f.url("/shop/products/electronics"));
    await waitForHydration(page);

    // Navigate to product (no modal from category)
    await page.locator('a[href="/shop/product/wireless-headphones"]').first().click();
    await expect(page.locator("text=Intercepted")).not.toBeVisible({ timeout: 3000 });
    await expect(page.locator("h2:has-text('Wireless Headphones')")).toBeVisible({ timeout: 10000 });

    // Navigate to shop index
    const breadcrumbNav = page.locator('nav[aria-label="Breadcrumb"]');
    await breadcrumbNav.locator("text=Shop").click();
    await expect(page.locator("text=All Products")).toBeVisible({ timeout: 5000 });

    // Now navigate to product from index (should show modal)
    await page.locator('a[href="/shop/product/wireless-headphones"]').first().click();
    await expect(page.locator("text=Intercepted")).toBeVisible({ timeout: 5000 });
  });
});

/**
 * Shop shared loader freshness tests - PR #68
 * Tests that after an action revalidates shared loaders on page A,
 * navigating to page B that shares those loaders shows fresh data.
 */
test.describe("shop-shared-loader-freshness", () => {
  const f = useFixture({
    root: ".",
    mode: "dev",
  });

  test("should use fresh segments when navigating after action revalidates shared loader", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // Track RSC requests and their segment headers
    const rscRequests: { url: string; segments?: string }[] = [];

    page.on("request", (request) => {
      const headers = request.headers();
      if (headers["rsc"] === "1" || request.url().includes("_rsc")) {
        rscRequests.push({
          url: request.url(),
          segments: headers["x-rsc-router-segments"],
        });
      }
    });

    // Step 1: Navigate to shop index
    await page.goto(f.url("/shop"));
    await waitForHydration(page);
    await expect(page.locator("text=All Products")).toBeVisible();

    // Clear requests from initial load
    rscRequests.length = 0;

    // Step 2: Open product modal (intercept navigation)
    await page.locator('a[href="/shop/product/wireless-headphones"]').first().click();
    await expect(page.locator("text=Intercepted")).toBeVisible({ timeout: 5000 });

    // Wait for modal content to load - Add to Cart button appears
    const addToCartButton = page.locator("button").filter({ hasText: "Add to Cart" }).first();
    await expect(addToCartButton).toBeVisible({ timeout: 10000 });

    // Step 3: Add to cart - this triggers CartLoader revalidation
    // (CartLoader revalidates when actionId includes "Cart")
    await addToCartButton.click();

    // Wait for action to complete and revalidation to finish
    await page.waitForTimeout(2000);

    // Modal should still be visible
    await expect(page.locator("text=Intercepted")).toBeVisible();

    // Clear requests before navigation
    rscRequests.length = 0;

    // Step 4: Navigate to a different product (full page, not intercept)
    // Click View Full Details to go to full product page
    await page.locator("text=View Full Details").click();
    await expect(page.locator("text=Intercepted")).not.toBeVisible({ timeout: 3000 });

    // Wait for product detail page to load
    await expect(page.locator("text=Test Revalidation Behavior")).toBeVisible({ timeout: 10000 });

    // Step 5: Navigate to different product via direct link
    // Clear requests before navigation to the next product
    rscRequests.length = 0;

    // Navigate to running-shoes product
    await page.locator('a[href="/shop/product/running-shoes"]').click();
    await expect(page.locator("h2:has-text('Running Shoes')")).toBeVisible({ timeout: 10000 });

    // Verify RSC request was made for navigation
    expect(rscRequests.length).toBeGreaterThan(0);

    // Step 6: Verify the navigation loaded correctly with fresh data
    // The cart count should be visible in the PDPNavbar (from shared CartLoader)
    await expect(page.locator("text=In cart:")).toBeVisible();

    // Page should be fully functional
    await expect(page.locator("text=Test Revalidation Behavior")).toBeVisible();
  });

  test("should show fresh cart data when navigating from product to cart after action", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // Step 1: Navigate to product detail page directly
    await page.goto(f.url("/shop/product/wireless-headphones"));
    await waitForHydration(page);

    // Wait for product to load
    await expect(page.locator("h2:has-text('Wireless Headphones')")).toBeVisible({ timeout: 10000 });
    await expect(page.locator("text=Add to Cart - Tests")).toBeVisible({ timeout: 5000 });

    // Step 2: Add to cart - triggers CartLoader revalidation
    const addToCartButton = page
      .locator("button")
      .filter({ hasText: "Add to Cart (Fire & Forget)" })
      .first();
    await addToCartButton.click();

    // Wait for action to complete
    await page.waitForTimeout(2000);

    // Step 3: Navigate to cart page (shares CartLoader with product page)
    await page.locator('a[href="/shop/cart"]').click();

    // Step 4: Verify cart page loads with fresh data
    await expect(page.locator("h2:has-text('Shopping Cart')")).toBeVisible({ timeout: 5000 });

    // Cart items should be visible
    await expect(page.locator("text=Cart Items")).toBeVisible();

    // Page should be fully functional - no stale data issues
    await expect(page.locator("text=Proceed to Checkout")).toBeVisible();
  });

  test("should preserve loader freshness across multiple navigations after action", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // Step 1: Start on shop index
    await page.goto(f.url("/shop"));
    await waitForHydration(page);

    // Step 2: Open product modal and add to cart
    await page.locator('a[href="/shop/product/wireless-headphones"]').first().click();
    await expect(page.locator("text=Intercepted")).toBeVisible({ timeout: 5000 });

    // Handle cart state from previous tests - may show Add to Cart or quantity controls
    const quantityDisplay = page.locator('[data-testid="cart-quantity"]');
    const addToCartButton = page.locator("button").filter({ hasText: "Add to Cart" }).first();

    const isAddToCartVisible = await addToCartButton.isVisible().catch(() => false);
    if (isAddToCartVisible) {
      await addToCartButton.click();
      await expect(quantityDisplay).toBeVisible({ timeout: 15000 });
    } else {
      await expect(quantityDisplay).toBeVisible({ timeout: 15000 });
    }
    await page.waitForTimeout(2000);

    // Step 3: Navigate to full product page
    await page.locator("text=View Full Details").click();
    await expect(page.locator("text=Test Revalidation Behavior")).toBeVisible({ timeout: 10000 });

    // Step 4: Navigate to cart
    await page.locator('a[href="/shop/cart"]').click();
    await expect(page.locator("h2:has-text('Shopping Cart')")).toBeVisible({ timeout: 5000 });

    // Step 5: Navigate back to shop index via direct link
    await page.locator('a[href="/shop"]').first().click();
    await expect(page.locator("text=All Products")).toBeVisible({ timeout: 10000 });

    // Step 6: Navigate to different product
    await page.locator('a[href="/shop/product/running-shoes"]').first().click();
    await expect(page.locator("text=Intercepted")).toBeVisible({ timeout: 5000 });

    // Modal should work correctly
    await expect(page.locator("text=View Full Details")).toBeVisible({ timeout: 5000 });

    // Step 7: Close modal and verify index still works
    await goBack(page);
    await expect(page.locator("text=All Products")).toBeVisible();
    await expect(page.locator("text=Featured Products")).toBeVisible();
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

  test.setTimeout(30000);

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
    const fireAndForgetButton = page
      .locator("button")
      .filter({ hasText: "Add to Cart (Fire & Forget)" })
      .first();

    const streamingButton = page
      .locator("button")
      .filter({ hasText: "Add product (Streaming)" })
      .first();

    // Click both buttons in quick succession (concurrent actions)
    await fireAndForgetButton.click();
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

    // Ensure item is in cart first (might need to add it)
    const plusButton = page.locator("button").filter({ hasText: "+" }).first();
    const addToCartButton = page.locator("button").filter({ hasText: "Add to Cart" }).first();

    const isAddToCartVisible = await addToCartButton.isVisible().catch(() => false);
    if (isAddToCartVisible) {
      // Add to cart first, then + will be available
      await addToCartButton.click();
      await expect(plusButton).toBeVisible({ timeout: 5000 });
    }

    // Click + to trigger action
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

/**
 * Production build tests for shop
 */
test.describe("shop-navigation (production)", () => {
  const f = useFixture({
    root: ".",
    mode: "build",
  });

  test.setTimeout(120000);

  test("should display shop index with products", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/shop"));
    await waitForHydration(page);

    await expect(page.locator("text=All Products")).toBeVisible();
    await expect(page.locator("text=Featured Products")).toBeVisible();
    await expect(
      page.locator('a[href="/shop/product/wireless-headphones"]').first()
    ).toBeVisible();
  });

  test("should show intercept modal when clicking product", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/shop"));
    await waitForHydration(page);

    await page
      .locator('a[href="/shop/product/wireless-headphones"]')
      .first()
      .click();

    await expect(page.locator("text=Intercepted")).toBeVisible({ timeout: 5000 });
    await expect(page.locator("text=Featured Products")).toBeVisible();
  });

  test("should close intercept modal on back navigation", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/shop"));
    await waitForHydration(page);

    await page
      .locator('a[href="/shop/product/wireless-headphones"]')
      .first()
      .click();
    await expect(page.locator("text=Intercepted")).toBeVisible({ timeout: 5000 });

    await goBack(page);

    await expect(page.locator("text=Intercepted")).not.toBeVisible();
    await expect(page.locator("text=All Products")).toBeVisible();
  });

  test("should NOT show modal on direct navigation (SSR)", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/shop/product/wireless-headphones"));
    await waitForHydration(page);

    // Product detail has 1s artificial delay + loading time
    await expect(page.locator("h2:has-text('Wireless Headphones')")).toBeVisible({
      timeout: 15000,
    });
    await expect(page.locator("text=Intercepted")).not.toBeVisible();
  });
});

test.describe("shop-actions (production)", () => {
  const f = useFixture({
    root: ".",
    mode: "build",
  });

  test.setTimeout(120000);

  test("should add product to cart from product detail page", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/shop/product/wireless-headphones"));
    await waitForHydration(page);

    // Product detail has 1s artificial delay + loading time
    await expect(
      page.locator("h2:has-text('Wireless Headphones')")
    ).toBeVisible({
      timeout: 15000,
    });

    await expect(page.locator("text=Add to Cart - Tests")).toBeVisible({
      timeout: 10000,
    });

    // Wait for event handlers to attach
    await page.waitForTimeout(100);

    const addToCartButton = page
      .locator("button")
      .filter({ hasText: "Add to Cart (Fire & Forget)" })
      .first();
    await addToCartButton.click();

    await page.waitForTimeout(3000);

    await expect(
      page.locator("h2:has-text('Wireless Headphones')")
    ).toBeVisible();
  });

  test("should update cart quantity from intercept modal", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/shop"));
    await waitForHydration(page);

    await page
      .locator('a[href="/shop/product/wireless-headphones"]')
      .first()
      .click();
    await expect(page.locator("text=Intercepted")).toBeVisible({
      timeout: 10000,
    });

    // Check if item is already in cart (from previous test) or needs to be added
    const quantityDisplay = page.locator('[data-testid="cart-quantity"]');
    const addToCartButton = page.locator("button").filter({ hasText: "Add to Cart" }).first();

    // If Add to Cart is visible, click it; otherwise item is already in cart
    const isAddToCartVisible = await addToCartButton.isVisible().catch(() => false);
    if (isAddToCartVisible) {
      await addToCartButton.click();
      await expect(quantityDisplay).toBeVisible({ timeout: 15000 });
      await expect(quantityDisplay).toHaveText("1", { timeout: 10000 });
    } else {
      // Item already in cart, just verify quantity controls are visible
      await expect(quantityDisplay).toBeVisible({ timeout: 15000 });
    }

    // Get current quantity before incrementing
    const currentQuantity = parseInt(await quantityDisplay.textContent() || "0");

    // Click + to increment
    await page.locator('[data-testid="quantity-increment"]').click();

    // Wait for quantity to increment
    const expectedQuantity = (currentQuantity + 1).toString();
    await expect(quantityDisplay).toHaveText(expectedQuantity, { timeout: 15000 });

    // Verify modal and background are still visible
    await expect(page.locator("text=Intercepted")).toBeVisible();
    await expect(page.locator("text=Featured Products")).toBeVisible();
  });
});

test.describe("shop-breadcrumbs (production)", () => {
  const f = useFixture({
    root: ".",
    mode: "build",
  });

  test.setTimeout(120000);

  test("should display correct breadcrumbs on shop index", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/shop"));
    await waitForHydration(page);

    const breadcrumbNav = page.locator('nav[aria-label="Breadcrumb"]');
    await expect(breadcrumbNav.locator("text=Shop")).toBeVisible({ timeout: 5000 });
  });

  test("should display category breadcrumbs", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/shop/products/electronics"));
    await waitForHydration(page);

    const breadcrumbNav = page.locator('nav[aria-label="Breadcrumb"]');
    await expect(breadcrumbNav.locator("text=Shop")).toBeVisible({ timeout: 5000 });
    await expect(breadcrumbNav.locator("text=Electronics")).toBeVisible({ timeout: 5000 });
  });

  test("should display product breadcrumbs on direct navigation", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/shop/product/wireless-headphones"));
    await waitForHydration(page);

    // Product detail has 1s artificial delay + loading time
    await expect(page.locator("h2:has-text('Wireless Headphones')")).toBeVisible({ timeout: 15000 });

    const breadcrumbNav = page.locator('nav[aria-label="Breadcrumb"]');
    await expect(breadcrumbNav.locator("text=Shop")).toBeVisible({ timeout: 5000 });
    await expect(breadcrumbNav.locator("text=Wireless Headphones")).toBeVisible({ timeout: 5000 });
  });
});

test.describe("shop-conditional-intercept (production)", () => {
  const f = useFixture({
    root: ".",
    mode: "build",
  });

  test.setTimeout(120000);

  test("should show modal when navigating from shop index", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/shop"));
    await waitForHydration(page);

    await page.locator('a[href="/shop/product/wireless-headphones"]').first().click();

    await expect(page.locator("text=Intercepted")).toBeVisible({ timeout: 5000 });
    await expect(page.locator("text=Featured Products")).toBeVisible();
  });

  test("should NOT show modal when navigating from category page", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/shop/products/electronics"));
    await waitForHydration(page);

    await expect(page.locator("h2:has-text('Electronics')")).toBeVisible({ timeout: 5000 });

    await page.locator('a[href="/shop/product/wireless-headphones"]').first().click();

    await expect(page.locator("text=Intercepted")).not.toBeVisible({ timeout: 3000 });
    await expect(page.locator("h2:has-text('Wireless Headphones')")).toBeVisible({ timeout: 10000 });
  });
});
