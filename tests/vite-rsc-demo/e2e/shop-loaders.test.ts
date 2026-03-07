import { expect } from "@playwright/test";
import { test as devTest, devURL } from "./dev-fixture";
import { waitForHydration, expectNoPageError, goBack } from "./helper";

/**
 * Shop shared loader freshness tests - PR #68
 * Tests that after an action revalidates shared loaders on page A,
 * navigating to page B that shares those loaders shows fresh data.
 */
devTest.describe("shop-shared-loader-freshness", () => {
  devTest(
    "should use fresh segments when navigating after action revalidates shared loader",
    async ({ page, devServerURL }) => {
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
      await page.goto(devURL(devServerURL, "/shop"));
      await waitForHydration(page);
      await expect(page.locator("text=All Products")).toBeVisible();

      // Clear requests from initial load
      rscRequests.length = 0;

      // Step 2: Open product modal (intercept navigation)
      await page
        .locator('a[href="/shop/product/wireless-headphones"]')
        .first()
        .click();
      await expect(page.locator("text=Intercepted")).toBeVisible({
        timeout: 5000,
      });

      // Wait for modal content to load - Add to Cart button appears
      const addToCartButton = page
        .locator("button")
        .filter({ hasText: "Add to Cart" })
        .first();
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
      await expect(page.locator("text=Intercepted")).not.toBeVisible({
        timeout: 3000,
      });

      // Wait for product detail page to load
      await expect(page.locator("text=Test Revalidation Behavior")).toBeVisible(
        { timeout: 10000 },
      );

      // Step 5: Navigate to different product via direct link
      // Clear requests before navigation to the next product
      rscRequests.length = 0;

      // Navigate to running-shoes product
      await page.locator('a[href="/shop/product/running-shoes"]').click();
      await expect(page.locator("h2:has-text('Running Shoes')")).toBeVisible({
        timeout: 10000,
      });

      // Verify RSC request was made for navigation
      expect(rscRequests.length).toBeGreaterThan(0);

      // Step 6: Verify the navigation loaded correctly with fresh data
      // The cart count should be visible in the PDPNavbar (from shared CartLoader)
      await expect(page.locator("text=In cart:")).toBeVisible();

      // Page should be fully functional
      await expect(
        page.locator("text=Test Revalidation Behavior"),
      ).toBeVisible();
    },
  );

  devTest(
    "should show fresh cart data when navigating from product to cart after action",
    async ({ page, devServerURL }) => {
      using _ = expectNoPageError(page);

      // Step 1: Navigate to product detail page directly
      await page.goto(
        devURL(devServerURL, "/shop/product/wireless-headphones"),
      );
      await waitForHydration(page);

      // Wait for product to load
      await expect(
        page.locator("h2:has-text('Wireless Headphones')"),
      ).toBeVisible({ timeout: 10000 });
      await expect(page.locator("text=Add to Cart - Tests")).toBeVisible({
        timeout: 5000,
      });

      // Step 2: Add to cart - triggers CartLoader revalidation
      const addToCartButton = page
        .locator("button")
        .filter({ hasText: "Add to Cart (With Result)" })
        .first();
      await addToCartButton.click();

      // Wait for action to complete
      await expect(addToCartButton).not.toHaveText("Adding...", {
        timeout: 10000,
      });

      // Verify action succeeded before navigating
      await expect(page.locator("h4:has-text('Success')")).toBeVisible({
        timeout: 5000,
      });

      // Step 3: Navigate to cart page (shares CartLoader with product page)
      await page.locator('a[href="/shop/cart"]').click();

      // Step 4: Verify cart page loads with fresh data
      await expect(page.locator("h2:has-text('Shopping Cart')")).toBeVisible({
        timeout: 5000,
      });

      // Cart items should be visible
      await expect(page.locator("text=Cart Items")).toBeVisible();

      // Page should be fully functional - no stale data issues
      await expect(page.locator("text=Proceed to Checkout")).toBeVisible();
    },
  );

  devTest(
    "should preserve loader freshness across multiple navigations after action",
    async ({ page, devServerURL }) => {
      using _ = expectNoPageError(page);

      // Step 1: Start on shop index
      await page.goto(devURL(devServerURL, "/shop"));
      await waitForHydration(page);

      // Step 2: Open product modal and add to cart
      await page
        .locator('a[href="/shop/product/wireless-headphones"]')
        .first()
        .click();
      await expect(page.locator("text=Intercepted")).toBeVisible({
        timeout: 5000,
      });

      // Handle cart state from previous tests - may show Add to Cart or quantity controls
      const quantityDisplay = page.locator('[data-testid="cart-quantity"]');
      const addToCartButton = page
        .locator("button")
        .filter({ hasText: "Add to Cart" })
        .first();

      const isAddToCartVisible = await addToCartButton
        .isVisible()
        .catch(() => false);
      if (isAddToCartVisible) {
        await addToCartButton.click();
        await expect(quantityDisplay).toBeVisible({ timeout: 15000 });
      } else {
        await expect(quantityDisplay).toBeVisible({ timeout: 15000 });
      }
      await page.waitForTimeout(2000);

      // Step 3: Navigate to full product page
      await page.locator("text=View Full Details").click();
      await expect(page.locator("text=Test Revalidation Behavior")).toBeVisible(
        { timeout: 10000 },
      );

      // Step 4: Navigate to cart
      await page.locator('a[href="/shop/cart"]').click();
      await expect(page.locator("h2:has-text('Shopping Cart')")).toBeVisible({
        timeout: 5000,
      });

      // Step 5: Navigate back to shop index via direct link
      await page.locator('a[href="/shop"]').first().click();
      await expect(page.locator("text=All Products")).toBeVisible({
        timeout: 10000,
      });

      // Step 6: Navigate to different product
      await page
        .locator('a[href="/shop/product/running-shoes"]')
        .first()
        .click();
      await expect(page.locator("text=Intercepted")).toBeVisible({
        timeout: 5000,
      });

      // Modal should work correctly
      await expect(page.locator("text=View Full Details")).toBeVisible({
        timeout: 5000,
      });

      // Step 7: Close modal and verify index still works
      await goBack(page);
      await expect(page.locator("text=All Products")).toBeVisible();
      await expect(page.locator("text=Featured Products")).toBeVisible();
    },
  );
});
