import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import {
  waitForHydration,
  expectNoPageError,
  goBack,
  getHistoryState,
} from "./helper";

/**
 * Navigation tests using isolated test app
 * Tests intercept navigation, cache consistency, and stale revalidation
 */
test.describe("intercept-navigation", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });

  test("should show modal when clicking product from index", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/"));
    await waitForHydration(page);

    // Click first product link
    const productLink = page.locator('[data-testid="product-link-product-a"]');
    await productLink.click();

    // Should show modal with product content
    await expect(page.locator('[data-testid="product-modal"]')).toBeVisible();

    // URL should change to product URL
    await expect(page).toHaveURL(/\/product\//);
  });

  test("should preserve background when navigating back from modal", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/"));
    await waitForHydration(page);

    // Click product to open modal
    const productLink = page.locator('[data-testid="product-link-product-a"]');
    await productLink.click();
    await expect(page.locator('[data-testid="product-modal"]')).toBeVisible();

    // Navigate back
    await goBack(page);

    // Should be back on index
    await expect(page).toHaveURL(/\/$/);

    // Modal should be gone
    await expect(page.locator('[data-testid="product-modal"]')).not.toBeVisible();
  });

  test("should navigate to full product page via View Full Details", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/"));
    await waitForHydration(page);

    // Open product modal
    const productLink = page.locator('[data-testid="product-link-product-a"]');
    await productLink.click();
    await expect(page.locator('[data-testid="product-modal"]')).toBeVisible();

    // Click View Full Details link inside modal
    await page.locator('[data-testid="view-full-details"]').click();

    // Should navigate to full product detail page (not intercepted)
    await page.waitForURL(/\/product\//);

    // Modal overlay should be gone
    await expect(page.locator('[data-testid="product-modal"]')).not.toBeVisible();

    // Product detail should show segment metadata
    await expect(page.locator('[data-testid="segment-metadata"]')).toBeVisible();
  });

  test("should show full product page on direct navigation", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // Navigate directly to product URL
    await page.goto(f.url("/product/product-a"));
    await waitForHydration(page);

    // Should NOT show intercepted modal
    await expect(page.locator('[data-testid="product-modal"]')).not.toBeVisible();

    // Should show full product detail page with segment metadata
    await expect(page.locator('[data-testid="segment-metadata"]')).toBeVisible();
  });

  test("should maintain intercept state in history", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/"));
    await waitForHydration(page);

    // Open product modal (intercept)
    const productLink = page.locator('[data-testid="product-link-product-a"]');
    await productLink.click();
    await expect(page.locator('[data-testid="product-modal"]')).toBeVisible();

    // Check history state has intercept flag
    const state = await getHistoryState(page);
    expect(state?.intercept).toBe(true);
  });
});

test.describe("action-cache-consistency", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });

  test("should preserve background when action completes after navigating back", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/"));
    await waitForHydration(page);

    // Open product modal
    const productLink = page.locator('[data-testid="product-link-product-a"]');
    await productLink.click();
    await expect(page.locator('[data-testid="product-modal"]')).toBeVisible();

    // Click quantity increment button (starts action)
    const incrementButton = page.locator('[data-testid="modal-quantity-control"] button:has-text("+")');
    await incrementButton.click();

    // Immediately navigate back before action completes
    await goBack(page);

    // Wait for stale responses
    await page.waitForTimeout(600);

    // Index content should still be visible
    await expect(page.locator('[data-testid="page-title"]')).toBeVisible();

    // Modal should be gone
    await expect(page.locator('[data-testid="product-modal"]')).not.toBeVisible();
  });

  test("should not corrupt cache when navigating from intercept to detail during action", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/"));
    await waitForHydration(page);

    // Open product modal (intercept)
    const productLink = page.locator('[data-testid="product-link-product-a"]');
    await productLink.click();
    await expect(page.locator('[data-testid="product-modal"]')).toBeVisible();

    // Click View Full Details
    await page.locator('[data-testid="view-full-details"]').click();
    await expect(page.locator('[data-testid="segment-metadata"]')).toBeVisible();

    // Start action on detail page
    const addToCartButton = page.locator('[data-testid="add-to-cart-btn"]');
    await addToCartButton.click();

    // Navigate back while action is in progress
    await goBack(page);

    // Wait for stale responses
    await page.waitForTimeout(600);

    // Should be back on intercepted view (modal)
    await expect(page.locator('[data-testid="product-modal"]')).toBeVisible();

    // Background should still be visible
    await expect(page.locator('[data-testid="page-title"]')).toBeVisible();
  });
});

test.describe("stale-revalidation", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });

  test("should restore from cache on back navigation", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/"));
    await waitForHydration(page);

    // Navigate to product via link
    const productLink = page.locator('[data-testid="product-link-product-a"]');
    await productLink.click();
    await expect(page.locator('[data-testid="product-modal"]')).toBeVisible();

    // Click View Full Details
    await page.locator('[data-testid="view-full-details"]').click();
    await expect(page.locator('[data-testid="segment-metadata"]')).toBeVisible();

    // Navigate back twice (to index)
    await goBack(page); // Back to intercept
    await goBack(page); // Back to index

    // Index should be restored immediately from cache
    await expect(page.locator('[data-testid="page-title"]')).toBeVisible();
  });

  test("should preserve intercept segments during stale revalidation", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/"));
    await waitForHydration(page);

    // Open product modal
    const productLink = page.locator('[data-testid="product-link-product-a"]');
    await productLink.click();
    await expect(page.locator('[data-testid="product-modal"]')).toBeVisible();

    // Store that we can see background
    await expect(page.locator('[data-testid="page-title"]')).toBeVisible();

    // Navigate back to close modal
    await goBack(page);
    await expect(page.locator('[data-testid="product-modal"]')).not.toBeVisible();

    // Navigate to a different product
    const productLink2 = page.locator('[data-testid="product-link-product-b"]');
    await productLink2.click();
    await expect(page.locator('[data-testid="product-modal"]')).toBeVisible();

    // Navigate back to index
    await goBack(page);

    // Index content should be restored
    await expect(page.locator('[data-testid="page-title"]')).toBeVisible();
  });

  test("should update quantity on intercept after action on detail page and back navigation", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/"));
    await waitForHydration(page);

    // 1. Click product to open modal (intercept)
    const productLink = page.locator('[data-testid="product-link-product-a"]');
    await productLink.click();
    await expect(page.locator('[data-testid="product-modal"]')).toBeVisible();

    // Get initial quantity in modal
    const modalQuantityDisplay = page.locator(
      '[data-testid="modal-quantity-control"] [data-testid="quantity-display"]'
    );
    const initialQuantity = parseInt(
      (await modalQuantityDisplay.textContent()) || "0"
    );

    // 2. Increment quantity in modal (action)
    const modalIncrementButton = page.locator(
      '[data-testid="modal-quantity-control"] button:has-text("+")'
    );
    await modalIncrementButton.click();

    // Wait for optimistic update
    await expect(modalQuantityDisplay).toContainText(
      String(initialQuantity + 1)
    );

    // 3. Go to details page
    await page.locator('[data-testid="view-full-details"]').click();
    await expect(page.locator('[data-testid="segment-metadata"]')).toBeVisible();
    await expect(page.locator('[data-testid="product-modal"]')).not.toBeVisible();

    // 4. Click add to cart on detail page and wait for it to complete
    const addToCartButton = page.locator('[data-testid="add-to-cart-btn"]');
    await addToCartButton.click();
    await expect(
      page.locator('[data-testid="add-to-cart-btn-result"]')
    ).toBeVisible({ timeout: 5000 });

    // 5. Go back - should return to intercept modal
    await goBack(page);
    await expect(page.locator('[data-testid="product-modal"]')).toBeVisible();

    // 6. Verify quantity was updated after revalidation
    // The quantity should reflect the add to cart action (initialQuantity + 1 from modal + 1 from add to cart = initialQuantity + 2)
    await expect(modalQuantityDisplay).toContainText(
      String(initialQuantity + 2),
      { timeout: 3000 }
    );
  });
});
