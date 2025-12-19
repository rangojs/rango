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
