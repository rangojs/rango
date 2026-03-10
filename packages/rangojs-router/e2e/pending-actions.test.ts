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
    await expect(page.locator('[data-testid="product-modal"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="page-title"]')).toBeVisible();

    // 3. Start action - click quantity increment
    const incrementButton = page.locator(
      '[data-testid="modal-quantity-control"] button:has-text("+")',
    );
    await expect(incrementButton).toHaveCount(1);
    await incrementButton.click();

    // 4. Immediately navigate to full detail page (same URL, non-intercept)
    await page.locator('[data-testid="view-full-details"]').click();
    await expect(
      page.locator('[data-testid="segment-metadata"]'),
    ).toBeVisible();
    await expect(page.locator('[data-testid="product-modal"]')).toHaveCount(0);

    // 5. Wait for pending action responses
    await page.waitForTimeout(600);

    // 6. Navigate back - should return to intercept view
    await goBack(page);

    // 7. Verify intercept is restored correctly - check for modal with View Full Details link
    await expect(
      page.locator('[data-testid="view-full-details"]'),
    ).toBeVisible();
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
    await expect(page.locator('[data-testid="product-modal"]')).toHaveCount(1);

    // 3. Go to full detail page
    await page.locator('[data-testid="view-full-details"]').click();
    await expect(
      page.locator('[data-testid="segment-metadata"]'),
    ).toBeVisible();

    // 4. Start action on detail page
    const addToCartButton = page.locator('[data-testid="add-to-cart-btn"]');
    await addToCartButton.click();

    // 5. Immediately navigate back to intercept
    await goBack(page);

    // 6. Should be on intercept view
    await expect(page.locator('[data-testid="product-modal"]')).toBeVisible();
    await expect(page.locator('[data-testid="product-modal"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="modal-product-name"]')).toHaveText(
      "Product A",
    );
    await expect(page.locator('[data-testid="page-title"]')).toBeVisible();

    // 7. Wait for action to complete in background
    await page.waitForTimeout(600);

    // 8. Verify UI is still correct
    await expect(page.locator('[data-testid="product-modal"]')).toBeVisible();
    await expect(page.locator('[data-testid="product-modal"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="modal-product-name"]')).toHaveText(
      "Product A",
    );
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
    await expect(page.locator('[data-testid="product-modal"]')).toHaveCount(1);

    // 3. Start action - click quantity increment
    const incrementButton = page.locator(
      '[data-testid="modal-quantity-control"] button:has-text("+")',
    );
    await expect(incrementButton).toHaveCount(1);
    await incrementButton.click();

    // 4. Close modal by navigating back (not waiting for action)
    await goBack(page);

    // 5. Should be on index
    await expect(page).toHaveURL(/\/$/);
    await expect(page.locator('[data-testid="page-title"]')).toBeVisible();
    await expect(page.locator('[data-testid="product-modal"]')).toHaveCount(0);

    // 6. Wait for action to complete
    await page.waitForTimeout(600);

    // 7. Index should still be intact
    await expect(page.locator('[data-testid="page-title"]')).toBeVisible();
    await expect(page.locator('[data-testid="product-modal"]')).toHaveCount(0);
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
    await expect(page.locator('[data-testid="product-modal"]')).toHaveCount(1);

    // 3. Start action - click quantity increment
    const incrementButton = page.locator(
      '[data-testid="modal-quantity-control"] button:has-text("+")',
    );
    await expect(incrementButton).toHaveCount(1);
    await incrementButton.click();

    // 4. Close modal and navigate to different product
    await goBack(page);
    const productLink2 = page.locator('[data-testid="product-link-product-b"]');
    await productLink2.click();
    await expect(page.locator('[data-testid="product-modal"]')).toBeVisible();
    await expect(page.locator('[data-testid="product-modal"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="modal-product-name"]')).toHaveText(
      "Product B",
    );
    await expect(
      page.locator('[data-testid="modal-product-name"]'),
    ).not.toHaveText("Product A");

    // 5. Wait for action to complete
    await page.waitForTimeout(600);

    // 6. Navigate back to index
    await goBack(page);
    await expect(page.locator('[data-testid="page-title"]')).toBeVisible();

    // 7. Index should be intact
    await expect(page.locator('[data-testid="product-modal"]')).toHaveCount(0);
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
      // Ensure page is stable before clicking
      await expect(page.locator('[data-testid="page-title"]')).toBeVisible();

      // Open modal
      const productLink = page.locator(
        '[data-testid="product-link-product-a"]',
      );
      await productLink.click();
      await expect(page.locator('[data-testid="product-modal"]')).toBeVisible();
      await expect(page.locator('[data-testid="product-modal"]')).toHaveCount(
        1,
      );

      // Fire action (don't wait) - click quantity increment
      const incrementButton = page.locator(
        '[data-testid="modal-quantity-control"] button:has-text("+")',
      );
      await expect(incrementButton).toHaveCount(1);
      await incrementButton.click();

      // Close immediately via back
      await goBack(page);
      await expect(page.locator('[data-testid="product-modal"]')).toHaveCount(
        0,
      );
    }

    // 3. Wait for all actions to settle
    await page.waitForTimeout(2000);

    // 4. Index should be in consistent state
    await expect(page.locator('[data-testid="page-title"]')).toBeVisible();
    await expect(page.locator('[data-testid="product-modal"]')).toHaveCount(0);

    // 5. Open modal one more time - should work correctly
    const productLink = page.locator('[data-testid="product-link-product-a"]');
    await productLink.click();
    await expect(page.locator('[data-testid="product-modal"]')).toBeVisible();
    await expect(page.locator('[data-testid="product-modal"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="page-title"]')).toBeVisible();
  });

  test("streaming action revalidation should be ignored after navigating away", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // 1. Navigate to product detail page directly (not via intercept)
    await page.goto(f.url("/product/product-a"));
    await waitForHydration(page);

    // Verify we're on detail page
    await expect(
      page.locator('[data-testid="segment-metadata"]'),
    ).toBeVisible();

    // 2. Start streaming action (3s delay)
    const streamingButton = page.locator('[data-testid="streaming-btn"]');
    await streamingButton.click();

    // Verify action started
    await expect(streamingButton).toBeDisabled();

    // 3. Navigate away to index BEFORE action completes
    const homeLink = page.locator('[data-testid="nav-home"]');
    await homeLink.click();

    // Verify we're on index
    await expect(page.locator('[data-testid="page-title"]')).toBeVisible();
    await expect(
      page.locator('[data-testid="segment-metadata"]'),
    ).not.toBeVisible();

    // 4. Wait for streaming action to complete in background (3s + buffer)
    await page.waitForTimeout(4000);

    // 5. CRITICAL: Verify the action's revalidation did NOT render
    // - Index should still be showing, not product detail
    // - No streaming result should appear on index page
    await expect(page.locator('[data-testid="page-title"]')).toBeVisible();
    await expect(
      page.locator('[data-testid="segment-metadata"]'),
    ).not.toBeVisible();
    await expect(
      page.locator('[data-testid="streaming-btn-result"]'),
    ).not.toBeVisible();

    // 6. Navigate back to product - should work normally
    await page.goBack();
    await expect(
      page.locator('[data-testid="segment-metadata"]'),
    ).toBeVisible();
  });

  test("action revalidation should be ignored when navigating to completely different route", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // 1. Navigate to product detail
    await page.goto(f.url("/product/product-a"));
    await waitForHydration(page);

    // 2. Start add to cart action
    const addToCartButton = page.locator('[data-testid="add-to-cart-btn"]');
    await addToCartButton.click();

    // 3. Immediately navigate to blog (completely different route)
    await page.goto(f.url("/blog"));
    await waitForHydration(page);

    // Verify we're on blog
    await expect(page.locator('[data-testid="blog-title"]')).toBeVisible();

    // 4. Wait for action to complete
    await page.waitForTimeout(1000);

    // 5. Blog should still be showing - action revalidation was ignored
    await expect(page.locator('[data-testid="blog-title"]')).toBeVisible();
    await expect(
      page.locator('[data-testid="product-detail-page"]'),
    ).not.toBeVisible();
    await expect(
      page.locator('[data-testid="add-to-cart-btn-result"]'),
    ).not.toBeVisible();
  });
});

// ============================================================================
// Production build
// ============================================================================

test.describe("pending-actions-navigation (production)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "build",
  });

  test("action on intercept, navigate to detail, action completes - should not corrupt intercept cache", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/"));
    await waitForHydration(page);

    const productLink = page.locator('[data-testid="product-link-product-a"]');
    await productLink.click();
    await expect(page.locator('[data-testid="product-modal"]')).toBeVisible();

    // Listen for the action POST response before triggering it
    const actionResponsePromise = page.waitForResponse(
      (res) => res.request().method() === "POST" && res.status() === 200,
    );

    const incrementButton = page.locator(
      '[data-testid="modal-quantity-control"] button:has-text("+")',
    );
    await expect(incrementButton).toHaveCount(1);
    await incrementButton.click();

    await page.locator('[data-testid="view-full-details"]').click();
    await expect(
      page.locator('[data-testid="segment-metadata"]'),
    ).toBeVisible();
    await expect(page.locator('[data-testid="product-modal"]')).toHaveCount(0);

    // Wait for the action response to be fully received instead of fixed sleep
    const actionResponse = await actionResponsePromise;
    await actionResponse.finished();

    await goBack(page);
    await expect(
      page.locator('[data-testid="view-full-details"]'),
    ).toBeVisible();
    await expect(page.locator('[data-testid="page-title"]')).toBeVisible();
  });

  test("action on intercept, close modal (back), action completes - index should remain intact", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/"));
    await waitForHydration(page);

    const productLink = page.locator('[data-testid="product-link-product-a"]');
    await productLink.click();
    await expect(page.locator('[data-testid="product-modal"]')).toBeVisible();

    // Listen for the action request to settle (complete or abort) before triggering it
    const actionSettledPromise = Promise.race([
      page.waitForEvent("requestfinished", {
        predicate: (req) => req.method() === "POST",
      }),
      page.waitForEvent("requestfailed", {
        predicate: (req) => req.method() === "POST",
      }),
    ]);

    const incrementButton = page.locator(
      '[data-testid="modal-quantity-control"] button:has-text("+")',
    );
    await expect(incrementButton).toHaveCount(1);
    await incrementButton.click();

    await goBack(page);

    await expect(page).toHaveURL(/\/$/);
    await expect(page.locator('[data-testid="page-title"]')).toBeVisible();
    await expect(page.locator('[data-testid="product-modal"]')).toHaveCount(0);

    // Wait for the action request to settle (response received or aborted by navigation)
    await actionSettledPromise;

    await expect(page.locator('[data-testid="page-title"]')).toBeVisible();
    await expect(page.locator('[data-testid="product-modal"]')).toHaveCount(0);
  });

  test("streaming action revalidation should be ignored after navigating away", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/product/product-a"));
    await waitForHydration(page);

    await expect(
      page.locator('[data-testid="segment-metadata"]'),
    ).toBeVisible();

    // Listen for the streaming action POST response before triggering it
    const actionResponsePromise = page.waitForResponse(
      (res) => res.request().method() === "POST" && res.status() === 200,
    );

    const streamingButton = page.locator('[data-testid="streaming-btn"]');
    await streamingButton.click();
    await expect(streamingButton).toBeDisabled();

    const homeLink = page.locator('[data-testid="nav-home"]');
    await homeLink.click();

    await expect(page.locator('[data-testid="page-title"]')).toBeVisible();

    // Wait for the streaming action response to be fully received instead of fixed sleep
    const actionResponse = await actionResponsePromise;
    await actionResponse.finished();

    await expect(page.locator('[data-testid="page-title"]')).toBeVisible();
    await expect(
      page.locator('[data-testid="segment-metadata"]'),
    ).not.toBeVisible();
    await expect(
      page.locator('[data-testid="streaming-btn-result"]'),
    ).not.toBeVisible();
  });
});
