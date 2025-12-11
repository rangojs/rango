import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError, goBack } from "./helper";

/**
 * Tests for complex scenarios where actions are not awaited
 * and user navigates away while action is still pending.
 *
 * Uses demo app to test cache preservation during pending actions.
 */
test.describe("pending-actions-navigation", () => {
  const f = useFixture({
    root: "../../examples/vite-rsc-demo",
    mode: "dev",
  });

  test("action on intercept, navigate to detail, action completes - should not corrupt intercept cache", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // 1. Navigate to shop index
    await page.goto(f.url("/shop"));
    await waitForHydration(page);

    // 2. Open product modal (intercept route)
    const productLink = page.locator('a[href*="/shop/product/"]').first();
    await productLink.click();
    await expect(page.locator('div[style*="position: fixed"]')).toBeVisible();
    await expect(page.locator('text=All Products')).toBeVisible();

    // 3. Start action - use increment button or Add to Cart depending on cart state
    await page.waitForSelector('button:has-text("+"), button:has-text("Add to Cart")', { timeout: 5000 });
    const incrementButton = page.locator('button:has-text("+")');
    if (await incrementButton.count() > 0) {
      await incrementButton.first().click();
    } else {
      await page.locator('button:has-text("Add to Cart")').first().click();
    }

    // 4. Immediately navigate to full detail page (same URL, non-intercept)
    await page.locator('text=View Full Details').click();
    await expect(page.locator('text=Segment Metadata')).toBeVisible();
    await expect(page.locator('div[style*="position: fixed"][style*="inset: 0"]')).not.toBeVisible();

    // 5. Wait for pending action responses
    await page.waitForTimeout(600);

    // 6. Navigate back - should return to intercept view
    await goBack(page);

    // 7. Verify intercept is restored correctly - check for modal with View Full Details link
    await expect(page.locator('text=View Full Details')).toBeVisible();
    await expect(page.locator('text=All Products')).toBeVisible();
  });

  test("action on detail page, navigate back to intercept, action completes - should preserve intercept", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // 1. Navigate to shop index
    await page.goto(f.url("/shop"));
    await waitForHydration(page);

    // 2. Open product modal (intercept)
    const productLink = page.locator('a[href*="/shop/product/"]').first();
    await productLink.click();
    await expect(page.locator('div[style*="position: fixed"]')).toBeVisible();

    // 3. Go to full detail page
    await page.locator('text=View Full Details').click();
    await expect(page.locator('text=Segment Metadata')).toBeVisible();

    // 4. Start action on detail page - use first useActionState button
    const actionButton = page.locator('button:has-text("Add to Cart (useActionState)")').first();
    await actionButton.click();

    // 5. Immediately navigate back to intercept
    await goBack(page);

    // 6. Should be on intercept view
    await expect(page.locator('div[style*="position: fixed"]')).toBeVisible();
    await expect(page.locator('text=All Products')).toBeVisible();

    // 7. Wait for action to complete in background
    await page.waitForTimeout(600);

    // 8. Verify UI is still correct
    await expect(page.locator('div[style*="position: fixed"]')).toBeVisible();
    await expect(page.locator('text=All Products')).toBeVisible();
  });

  test("action on intercept, close modal (back), action completes - index should remain intact", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // 1. Navigate to shop index
    await page.goto(f.url("/shop"));
    await waitForHydration(page);

    // 2. Open product modal
    const productLink = page.locator('a[href*="/shop/product/"]').first();
    await productLink.click();
    await expect(page.locator('div[style*="position: fixed"]')).toBeVisible();

    // 3. Start action - use increment button or Add to Cart depending on cart state
    // Wait for one of the buttons to appear
    await page.waitForSelector('button:has-text("+"), button:has-text("Add to Cart")', { timeout: 5000 });
    const incrementButton = page.locator('button:has-text("+")');
    if (await incrementButton.count() > 0) {
      await incrementButton.first().click();
    } else {
      await page.locator('button:has-text("Add to Cart")').first().click();
    }

    // 4. Close modal by navigating back (not waiting for action)
    await goBack(page);

    // 5. Should be on shop index
    await expect(page).toHaveURL(/\/shop\/?$/);
    await expect(page.locator('text=All Products')).toBeVisible();
    await expect(page.locator('div[style*="position: fixed"][style*="inset: 0"]')).not.toBeVisible();

    // 6. Wait for action to complete
    await page.waitForTimeout(600);

    // 7. Shop index should still be intact
    await expect(page.locator('text=All Products')).toBeVisible();
    await expect(page.locator('div[style*="position: fixed"][style*="inset: 0"]')).not.toBeVisible();
  });

  test("action on intercept, navigate to cart, back to shop - should restore correctly", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // 1. Navigate to shop index
    await page.goto(f.url("/shop"));
    await waitForHydration(page);

    // 2. Open product modal
    const productLink = page.locator('a[href*="/shop/product/"]').first();
    await productLink.click();
    await expect(page.locator('div[style*="position: fixed"]')).toBeVisible();

    // 3. Start action - use increment button or Add to Cart depending on cart state
    await page.waitForSelector('button:has-text("+"), button:has-text("Add to Cart")', { timeout: 5000 });
    const incrementButton = page.locator('button:has-text("+")');
    if (await incrementButton.count() > 0) {
      await incrementButton.first().click();
    } else {
      await page.locator('button:has-text("Add to Cart")').first().click();
    }

    // 4. Close modal and navigate to cart
    await goBack(page);
    await page.locator('a[href*="/shop/cart"]').click();
    await expect(page).toHaveURL(/\/shop\/cart$/);

    // 5. Wait for action to complete
    await page.waitForTimeout(600);

    // 6. Navigate back to shop
    await goBack(page);
    await expect(page.locator('text=All Products')).toBeVisible();

    // 7. Shop index should be intact
    await expect(page.locator('div[style*="position: fixed"][style*="inset: 0"]')).not.toBeVisible();
  });

  test("rapid open/close modal with actions - should not leak state", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // 1. Navigate to shop index
    await page.goto(f.url("/shop"));
    await waitForHydration(page);

    // 2. Rapidly open modal, action, close - multiple times
    for (let i = 0; i < 3; i++) {
      // Open modal
      const productLink = page.locator('a[href*="/shop/product/"]').first();
      await productLink.click();
      await expect(page.locator('div[style*="position: fixed"]')).toBeVisible();

      // Fire action (don't wait) - use increment button or Add to Cart depending on cart state
      await page.waitForSelector('button:has-text("+"), button:has-text("Add to Cart")', { timeout: 5000 });
      const incrementButton = page.locator('button:has-text("+")');
      if (await incrementButton.count() > 0) {
        await incrementButton.first().click();
      } else {
        await page.locator('button:has-text("Add to Cart")').first().click();
      }

      // Close immediately via back
      await goBack(page);
      await expect(page.locator('div[style*="position: fixed"][style*="inset: 0"]')).not.toBeVisible();
    }

    // 3. Wait for all actions to settle
    await page.waitForTimeout(2000);

    // 4. Shop index should be in consistent state
    await expect(page.locator('text=All Products')).toBeVisible();
    await expect(page.locator('div[style*="position: fixed"][style*="inset: 0"]')).not.toBeVisible();

    // 5. Open modal one more time - should work correctly
    const productLink = page.locator('a[href*="/shop/product/"]').first();
    await productLink.click();
    await expect(page.locator('div[style*="position: fixed"]')).toBeVisible();
    await expect(page.locator('text=All Products')).toBeVisible();
  });
});
