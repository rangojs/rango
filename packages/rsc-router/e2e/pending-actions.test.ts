import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError, goBack } from "./helper";

/**
 * Tests for complex scenarios where actions are not awaited
 * and user navigates away while action is still pending.
 *
 * Uses isolated test app to test cache preservation during pending actions.
 */
test.describe("pending-actions-navigation", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });

  test("action on intercept, navigate to detail, action completes - should not corrupt intercept cache", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // 1. Navigate to index
    await page.goto(f.url("/"));
    await waitForHydration(page);

    // 2. Open product modal (intercept route)
    const productLink = page.locator('[data-testid="product-link-product-a"]');
    await productLink.click();
    await expect(page.locator('[data-testid="product-modal"]')).toBeVisible();
    await expect(page.locator('[data-testid="page-title"]')).toBeVisible();

    // 3. Start action - click quantity increment
    const incrementButton = page.locator('[data-testid="modal-quantity-control"] button:has-text("+")');
    await incrementButton.click();

    // 4. Immediately navigate to full detail page (same URL, non-intercept)
    await page.locator('[data-testid="view-full-details"]').click();
    await expect(page.locator('[data-testid="segment-metadata"]')).toBeVisible();
    await expect(page.locator('[data-testid="product-modal"]')).not.toBeVisible();

    // 5. Wait for pending action responses
    await page.waitForTimeout(600);

    // 6. Navigate back - should return to intercept view
    await goBack(page);

    // 7. Verify intercept is restored correctly - check for modal with View Full Details link
    await expect(page.locator('[data-testid="view-full-details"]')).toBeVisible();
    await expect(page.locator('[data-testid="page-title"]')).toBeVisible();
  });

  test("action on detail page, navigate back to intercept, action completes - should preserve intercept", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // 1. Navigate to index
    await page.goto(f.url("/"));
    await waitForHydration(page);

    // 2. Open product modal (intercept)
    const productLink = page.locator('[data-testid="product-link-product-a"]');
    await productLink.click();
    await expect(page.locator('[data-testid="product-modal"]')).toBeVisible();

    // 3. Go to full detail page
    await page.locator('[data-testid="view-full-details"]').click();
    await expect(page.locator('[data-testid="segment-metadata"]')).toBeVisible();

    // 4. Start action on detail page
    const addToCartButton = page.locator('[data-testid="add-to-cart-btn"]');
    await addToCartButton.click();

    // 5. Immediately navigate back to intercept
    await goBack(page);

    // 6. Should be on intercept view
    await expect(page.locator('[data-testid="product-modal"]')).toBeVisible();
    await expect(page.locator('[data-testid="page-title"]')).toBeVisible();

    // 7. Wait for action to complete in background
    await page.waitForTimeout(600);

    // 8. Verify UI is still correct
    await expect(page.locator('[data-testid="product-modal"]')).toBeVisible();
    await expect(page.locator('[data-testid="page-title"]')).toBeVisible();
  });

  test("action on intercept, close modal (back), action completes - index should remain intact", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // 1. Navigate to index
    await page.goto(f.url("/"));
    await waitForHydration(page);

    // 2. Open product modal
    const productLink = page.locator('[data-testid="product-link-product-a"]');
    await productLink.click();
    await expect(page.locator('[data-testid="product-modal"]')).toBeVisible();

    // 3. Start action - click quantity increment
    const incrementButton = page.locator('[data-testid="modal-quantity-control"] button:has-text("+")');
    await incrementButton.click();

    // 4. Close modal by navigating back (not waiting for action)
    await goBack(page);

    // 5. Should be on index
    await expect(page).toHaveURL(/\/$/);
    await expect(page.locator('[data-testid="page-title"]')).toBeVisible();
    await expect(page.locator('[data-testid="product-modal"]')).not.toBeVisible();

    // 6. Wait for action to complete
    await page.waitForTimeout(600);

    // 7. Index should still be intact
    await expect(page.locator('[data-testid="page-title"]')).toBeVisible();
    await expect(page.locator('[data-testid="product-modal"]')).not.toBeVisible();
  });

  test("action on intercept, navigate to different product, back to index - should restore correctly", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // 1. Navigate to index
    await page.goto(f.url("/"));
    await waitForHydration(page);

    // 2. Open product modal
    const productLink = page.locator('[data-testid="product-link-product-a"]');
    await productLink.click();
    await expect(page.locator('[data-testid="product-modal"]')).toBeVisible();

    // 3. Start action - click quantity increment
    const incrementButton = page.locator('[data-testid="modal-quantity-control"] button:has-text("+")');
    await incrementButton.click();

    // 4. Close modal and navigate to different product
    await goBack(page);
    const productLink2 = page.locator('[data-testid="product-link-product-b"]');
    await productLink2.click();
    await expect(page.locator('[data-testid="product-modal"]')).toBeVisible();

    // 5. Wait for action to complete
    await page.waitForTimeout(600);

    // 6. Navigate back to index
    await goBack(page);
    await expect(page.locator('[data-testid="page-title"]')).toBeVisible();

    // 7. Index should be intact
    await expect(page.locator('[data-testid="product-modal"]')).not.toBeVisible();
  });

  test("rapid open/close modal with actions - should not leak state", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // 1. Navigate to index
    await page.goto(f.url("/"));
    await waitForHydration(page);

    // 2. Rapidly open modal, action, close - multiple times
    for (let i = 0; i < 3; i++) {
      // Open modal
      const productLink = page.locator('[data-testid="product-link-product-a"]');
      await productLink.click();
      await expect(page.locator('[data-testid="product-modal"]')).toBeVisible();

      // Fire action (don't wait) - click quantity increment
      const incrementButton = page.locator('[data-testid="modal-quantity-control"] button:has-text("+")');
      await incrementButton.click();

      // Close immediately via back
      await goBack(page);
      await expect(page.locator('[data-testid="product-modal"]')).not.toBeVisible();
    }

    // 3. Wait for all actions to settle
    await page.waitForTimeout(2000);

    // 4. Index should be in consistent state
    await expect(page.locator('[data-testid="page-title"]')).toBeVisible();
    await expect(page.locator('[data-testid="product-modal"]')).not.toBeVisible();

    // 5. Open modal one more time - should work correctly
    const productLink = page.locator('[data-testid="product-link-product-a"]');
    await productLink.click();
    await expect(page.locator('[data-testid="product-modal"]')).toBeVisible();
    await expect(page.locator('[data-testid="page-title"]')).toBeVisible();
  });
});
