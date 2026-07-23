import { expect, test } from "@playwright/test";
import { test as devTest, devURL } from "./dev-fixture";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError, goBack } from "./helper";

/**
 * Shop intercept route tests - background preservation during action revalidation
 */
devTest.describe("shop-intercept-background-preservation", () => {
  devTest(
    "should preserve background data when action completes after navigating back to intercept",
    async ({ page, devServerURL }) => {
      using _ = expectNoPageError(page);

      // Step 1: Navigate to shop page
      await page.goto(devURL(devServerURL, "/shop"));
      await waitForHydration(page);

      // Verify shop page shows product grid
      await expect(page.locator("text=All Products")).toBeVisible();
      await expect(page.locator("text=Featured Products")).toBeVisible();

      // Step 2: Click on a product to open intercept modal
      // Click on the product link (the card in the product grid)
      await page
        .locator('a[href="/shop/product/wireless-headphones"]')
        .first()
        .click();
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
      await expect(
        page.locator("text=Test Revalidation Behavior"),
      ).toBeVisible();
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
    },
  );
});

/**
 * Shop navigation tests
 */
devTest.describe("shop-navigation", () => {
  devTest(
    "should display shop index with products",
    async ({ page, devServerURL }) => {
      using _ = expectNoPageError(page);

      await page.goto(devURL(devServerURL, "/shop"));
      await waitForHydration(page);

      // Shop index should show products
      await expect(page.locator("text=All Products")).toBeVisible();
      await expect(page.locator("text=Featured Products")).toBeVisible();

      // Product links should be visible
      await expect(
        page.locator('a[href="/shop/product/wireless-headphones"]').first(),
      ).toBeVisible();
    },
  );

  devTest(
    "should show intercept modal with loading skeleton when clicking product",
    async ({ page, devServerURL }) => {
      using _ = expectNoPageError(page);

      await page.goto(devURL(devServerURL, "/shop"));
      await waitForHydration(page);

      // Click on a product
      await page
        .locator('a[href="/shop/product/wireless-headphones"]')
        .first()
        .click();

      // Modal loading skeleton should appear briefly (has shimmer animation)
      // The modal wrapper should be visible
      await expect(page.locator("text=Intercepted")).toBeVisible({
        timeout: 3000,
      });

      // Background should remain visible
      await expect(page.locator("text=Featured Products")).toBeVisible();
    },
  );

  devTest(
    "should NOT show loading skeleton on direct navigation (SSR)",
    async ({ page, devServerURL }) => {
      using _ = expectNoPageError(page);

      // Direct navigation to product page (hard navigation / SSR)
      await page.goto(
        devURL(devServerURL, "/shop/product/wireless-headphones"),
      );
      await waitForHydration(page);

      // Should show product content directly (no skeleton for SSR)
      // The product detail has a 1s artificial delay but loading(skeleton, true)
      // means skeleton is only shown for client-side navigation, not SSR
      await expect(
        page.locator("h2:has-text('Wireless Headphones')"),
      ).toBeVisible({
        timeout: 5000,
      });

      // Should NOT be intercepted on direct navigation
      await expect(page.locator("text=Intercepted")).not.toBeVisible();
    },
  );

  devTest(
    "should close intercept modal on back navigation",
    async ({ page, devServerURL }) => {
      using _ = expectNoPageError(page);

      await page.goto(devURL(devServerURL, "/shop"));
      await waitForHydration(page);

      // Open modal
      await page
        .locator('a[href="/shop/product/wireless-headphones"]')
        .first()
        .click();
      await expect(page.locator("text=Intercepted")).toBeVisible({
        timeout: 3000,
      });

      // Navigate back
      await goBack(page);

      // Modal should be closed
      await expect(page.locator("text=Intercepted")).not.toBeVisible();

      // Shop page should be restored
      await expect(page.locator("text=All Products")).toBeVisible();
      await expect(page.locator("text=Featured Products")).toBeVisible();
    },
  );

  devTest(
    "should navigate from intercept modal to full product page",
    async ({ page, devServerURL }) => {
      using _ = expectNoPageError(page);

      await page.goto(devURL(devServerURL, "/shop"));
      await waitForHydration(page);

      // Open modal
      await page
        .locator('a[href="/shop/product/wireless-headphones"]')
        .first()
        .click();
      await expect(page.locator("text=Intercepted")).toBeVisible({
        timeout: 3000,
      });

      // Click View Full Details
      await page.locator("text=View Full Details").click();

      // Should navigate to full product page
      await expect(page.locator("text=Intercepted")).not.toBeVisible({
        timeout: 3000,
      });
      await expect(page).toHaveURL(/\/shop\/product\/wireless-headphones/, {
        timeout: 5000,
      });

      // Full product page content should be visible
      await expect(
        page.locator("h2:has-text('Wireless Headphones')"),
      ).toBeVisible({
        timeout: 10000,
      });
    },
  );

  devTest(
    "should navigate from intercept modal to full product page multiple times",
    async ({ page, devServerURL }) => {
      using _ = expectNoPageError(page);

      await page.goto(devURL(devServerURL, "/shop"));
      await waitForHydration(page);

      // First attempt: Open modal and navigate to full details
      await page
        .locator('a[href="/shop/product/wireless-headphones"]')
        .first()
        .click();
      await expect(page.locator("text=Intercepted")).toBeVisible({
        timeout: 3000,
      });
      await page.locator("text=View Full Details").click();
      await expect(page.locator("text=Intercepted")).not.toBeVisible({
        timeout: 3000,
      });
      await expect(page).toHaveURL(/\/shop\/product\/wireless-headphones/, {
        timeout: 5000,
      });
      await expect(
        page.locator("h2:has-text('Wireless Headphones')"),
      ).toBeVisible({
        timeout: 10000,
      });

      // Go back to shop
      await page.locator('a[href="/shop"]').first().click();
      await expect(page.locator("text=All Products")).toBeVisible({
        timeout: 3000,
      });

      // Second attempt: Open different product modal and navigate to full details
      await page
        .locator('a[href="/shop/product/running-shoes"]')
        .first()
        .click();
      await expect(page.locator("text=Intercepted")).toBeVisible({
        timeout: 3000,
      });
      // Check the modal header has the product name
      await expect(page.locator("h2:has-text('Running Shoes')")).toBeVisible({
        timeout: 3000,
      });
      await page.locator("text=View Full Details").click();
      await expect(page.locator("text=Intercepted")).not.toBeVisible({
        timeout: 3000,
      });
      await expect(page).toHaveURL(/\/shop\/product\/running-shoes/, {
        timeout: 5000,
      });
      await expect(page.locator("h2:has-text('Running Shoes')")).toBeVisible({
        timeout: 10000,
      });

      // Go back to shop again
      await page.locator('a[href="/shop"]').first().click();
      await expect(page.locator("text=All Products")).toBeVisible({
        timeout: 3000,
      });

      // Third attempt: Open same product again and verify it works
      await page
        .locator('a[href="/shop/product/wireless-headphones"]')
        .first()
        .click();
      await expect(page.locator("text=Intercepted")).toBeVisible({
        timeout: 3000,
      });
      await page.locator("text=View Full Details").click();
      await expect(page.locator("text=Intercepted")).not.toBeVisible({
        timeout: 3000,
      });
      await expect(page).toHaveURL(/\/shop\/product\/wireless-headphones/, {
        timeout: 5000,
      });
      await expect(
        page.locator("h2:has-text('Wireless Headphones')"),
      ).toBeVisible({
        timeout: 10000,
      });
    },
  );
});

/**
 * Shop conditional intercept tests - { when } config selector behavior
 * The shop intercept has: { when: ({ from }) => !from.pathname.startsWith("/shop/products/") }
 * This means modal shows from /shop index, but NOT from category pages
 */
devTest.describe("shop-conditional-intercept", () => {
  devTest(
    "should show modal when navigating from shop index",
    async ({ page, devServerURL }) => {
      using _ = expectNoPageError(page);

      // Start on shop index
      await page.goto(devURL(devServerURL, "/shop"));
      await waitForHydration(page);

      // Click on a product from index
      await page
        .locator('a[href="/shop/product/wireless-headphones"]')
        .first()
        .click();

      // Should show intercept modal (when condition: from=/shop, not starting with /shop/products/)
      await expect(page.locator("text=Intercepted")).toBeVisible({
        timeout: 5000,
      });

      // Background should remain visible
      await expect(page.locator("text=Featured Products")).toBeVisible();
    },
  );

  devTest(
    "should NOT show modal when navigating from category page",
    async ({ page, devServerURL }) => {
      using _ = expectNoPageError(page);

      // Start on category page
      await page.goto(devURL(devServerURL, "/shop/products/electronics"));
      await waitForHydration(page);

      // Verify we're on category page
      await expect(page.locator("h2:has-text('Electronics')")).toBeVisible({
        timeout: 5000,
      });

      // Click on a product from category
      await page
        .locator('a[href="/shop/product/wireless-headphones"]')
        .first()
        .click();

      // Should NOT show intercept modal (when condition fails: from=/shop/products/electronics)
      await expect(page.locator("text=Intercepted")).not.toBeVisible({
        timeout: 3000,
      });

      // Should show full product page
      await expect(
        page.locator("h2:has-text('Wireless Headphones')"),
      ).toBeVisible({ timeout: 10000 });
      await expect(page.locator("text=Test Revalidation Behavior")).toBeVisible(
        { timeout: 5000 },
      );
    },
  );

  devTest(
    "should preserve modal during action revalidation",
    async ({ page, devServerURL }) => {
      using _ = expectNoPageError(page);

      // Start on shop index
      await page.goto(devURL(devServerURL, "/shop"));
      await waitForHydration(page);

      // Open modal from index
      await page
        .locator('a[href="/shop/product/wireless-headphones"]')
        .first()
        .click();
      await expect(page.locator("text=Intercepted")).toBeVisible({
        timeout: 5000,
      });

      // Wait for modal content to load - "Add to Cart" button appears first
      const addToCartButton = page
        .locator("button")
        .filter({ hasText: "Add to Cart" })
        .first();
      await expect(addToCartButton).toBeVisible({ timeout: 10000 });

      // First add to cart (this will show quantity controls with + button)
      await addToCartButton.click();

      // Wait for quantity controls to appear (+ button shows after item is in cart)
      const plusButton = page
        .locator("button")
        .filter({ hasText: "+" })
        .first();
      await expect(plusButton).toBeVisible({ timeout: 5000 });

      // Perform action in modal (click + to increase quantity)
      await plusButton.click();

      // Wait for action to complete
      await page.waitForTimeout(2000);

      // Modal should still be visible (when() is skipped during action revalidation)
      await expect(page.locator("text=Intercepted")).toBeVisible();

      // Background should still be visible
      await expect(page.locator("text=Featured Products")).toBeVisible();
    },
  );

  devTest(
    "should show modal from index after navigating from category to product to index",
    async ({ page, devServerURL }) => {
      using _ = expectNoPageError(page);

      // Start on category page
      await page.goto(devURL(devServerURL, "/shop/products/electronics"));
      await waitForHydration(page);

      // Navigate to product (no modal from category)
      await page
        .locator('a[href="/shop/product/wireless-headphones"]')
        .first()
        .click();
      await expect(page.locator("text=Intercepted")).not.toBeVisible({
        timeout: 3000,
      });
      await expect(
        page.locator("h2:has-text('Wireless Headphones')"),
      ).toBeVisible({ timeout: 10000 });

      // Navigate to shop index via Products link in shop header
      await page.locator('a:has-text("Products")').click();
      await expect(page.locator("text=All Products")).toBeVisible({
        timeout: 10000,
      });

      // Now navigate to product from index (should show modal)
      await page
        .locator('a[href="/shop/product/wireless-headphones"]')
        .first()
        .click();
      await expect(page.locator("text=Intercepted")).toBeVisible({
        timeout: 5000,
      });
    },
  );
});

/**
 * Shop intercept background preservation (production build)
 *
 * Regression: a fire-and-forget action's background revalidation must not
 * unmount the preserved intercept background. The assertion (background stays
 * visible after revalidation) is logical, not timing-dependent; the waits are
 * generously larger than the product route's 1s render delay.
 */
test.describe("shop-intercept-background-preservation (production)", () => {
  const f = useFixture({
    root: ".",
    mode: "build",
  });

  test.setTimeout(120000);

  test("should preserve background data when action completes after navigating back to intercept", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // Step 1: shop index
    await page.goto(f.url("/shop"));
    await waitForHydration(page);

    await expect(page.locator("text=All Products")).toBeVisible();
    await expect(page.locator("text=Featured Products")).toBeVisible();

    // Step 2: open intercept modal
    await page
      .locator('a[href="/shop/product/wireless-headphones"]')
      .first()
      .click();
    await expect(page).toHaveURL(/\/shop\/product\/wireless-headphones/);
    await expect(page.locator("text=Intercepted")).toBeVisible({
      timeout: 5000,
    });
    await expect(page.locator("text=Featured Products")).toBeVisible();

    // Step 3: go to full product page (non-intercept)
    await page.locator("text=View Full Details").click();
    await expect(page.locator("text=Intercepted")).not.toBeVisible({
      timeout: 5000,
    });
    await expect(page.locator("text=Test Revalidation Behavior")).toBeVisible({
      timeout: 15000,
    });

    const addToCartButton = page
      .locator("button")
      .filter({ hasText: "Add to Cart (Fire & Forget)" })
      .first();
    await expect(addToCartButton).toBeVisible({ timeout: 10000 });

    // Step 4: fire the action, then race a back-navigation to the modal
    await addToCartButton.click();
    await page.waitForTimeout(300);

    // Step 5: navigate back to the intercept modal
    await goBack(page);
    await expect(page.locator("text=Intercepted")).toBeVisible({
      timeout: 5000,
    });
    await expect(page.locator("text=Featured Products")).toBeVisible();

    // Step 6: allow the action + background revalidation to settle.
    await page.waitForTimeout(5000);

    // Background must remain mounted after revalidation.
    await expect(page.locator("text=Featured Products")).toBeVisible({
      timeout: 2000,
    });
    await expect(page.locator("text=Intercepted")).toBeVisible();
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
      page.locator('a[href="/shop/product/wireless-headphones"]').first(),
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

    await expect(page.locator("text=Intercepted")).toBeVisible({
      timeout: 5000,
    });
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
    await expect(page.locator("text=Intercepted")).toBeVisible({
      timeout: 5000,
    });

    await goBack(page);

    await expect(page.locator("text=Intercepted")).not.toBeVisible();
    await expect(page.locator("text=All Products")).toBeVisible();
  });

  test("should NOT show modal on direct navigation (SSR)", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/shop/product/wireless-headphones"));
    await waitForHydration(page);

    // Product detail has 1s artificial delay + loading time
    await expect(
      page.locator("h2:has-text('Wireless Headphones')"),
    ).toBeVisible({
      timeout: 15000,
    });
    await expect(page.locator("text=Intercepted")).not.toBeVisible();
  });
});

test.describe("shop-conditional-intercept (production)", () => {
  const f = useFixture({
    root: ".",
    mode: "build",
  });

  test.setTimeout(120000);

  test("should show modal when navigating from shop index", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/shop"));
    await waitForHydration(page);

    await page
      .locator('a[href="/shop/product/wireless-headphones"]')
      .first()
      .click();

    await expect(page.locator("text=Intercepted")).toBeVisible({
      timeout: 5000,
    });
    await expect(page.locator("text=Featured Products")).toBeVisible();
  });

  test("should NOT show modal when navigating from category page", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/shop/products/electronics"));
    await waitForHydration(page);

    await expect(page.locator("h2:has-text('Electronics')")).toBeVisible({
      timeout: 5000,
    });

    await page
      .locator('a[href="/shop/product/wireless-headphones"]')
      .first()
      .click();

    await expect(page.locator("text=Intercepted")).not.toBeVisible({
      timeout: 3000,
    });
    await expect(
      page.locator("h2:has-text('Wireless Headphones')"),
    ).toBeVisible({ timeout: 10000 });
  });
});
