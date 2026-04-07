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
    await expect(
      page.locator('[data-testid="product-modal"]'),
    ).not.toBeVisible();
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
    await expect(
      page.locator('[data-testid="product-modal"]'),
    ).not.toBeVisible();

    // Product detail should show segment metadata
    await expect(
      page.locator('[data-testid="segment-metadata"]'),
    ).toBeVisible();
  });

  test("should preserve parallel segments when leaving intercept via View Full Details", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/"));
    await waitForHydration(page);

    // Sidebar parallel should be visible on index
    await expect(page.locator('[data-testid="sidebar"]')).toBeVisible();

    // Open product modal (intercept)
    const productLink = page.locator('[data-testid="product-link-product-a"]');
    await productLink.click();
    await expect(page.locator('[data-testid="product-modal"]')).toBeVisible();

    // Sidebar should still be visible behind modal
    await expect(page.locator('[data-testid="sidebar"]')).toBeVisible();

    // Click View Full Details to leave intercept
    await page.locator('[data-testid="view-full-details"]').click();

    // Should navigate to full product detail page
    await expect(
      page.locator('[data-testid="product-modal"]'),
    ).not.toBeVisible();
    await expect(
      page.locator('[data-testid="segment-metadata"]'),
    ).toBeVisible();

    // Sidebar parallel segment must be preserved after leaving intercept
    await expect(page.locator('[data-testid="sidebar"]')).toBeVisible();
  });

  test("should show full product page on direct navigation", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // Navigate directly to product URL
    await page.goto(f.url("/product/product-a"));
    await waitForHydration(page);

    // Should NOT show intercepted modal
    await expect(
      page.locator('[data-testid="product-modal"]'),
    ).not.toBeVisible();

    // Should show full product detail page with segment metadata
    await expect(
      page.locator('[data-testid="segment-metadata"]'),
    ).toBeVisible();

    // Sidebar should be visible on direct navigation too
    await expect(page.locator('[data-testid="sidebar"]')).toBeVisible();
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

  test("should show index background when reopening modal after detail page navigation", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/"));
    await waitForHydration(page);

    // Step 1: Click product to open modal
    const productLink = page.locator('[data-testid="product-link-product-a"]');
    await productLink.click();
    await expect(page.locator('[data-testid="product-modal"]')).toBeVisible();

    // Background should show index content (product list visible)
    await expect(
      page.locator('[data-testid="product-link-product-b"]'),
    ).toBeVisible();

    // Step 2: Click "View Full Details" to navigate to detail page
    await page.locator('[data-testid="view-full-details"]').click();
    await page.waitForURL(/\/product\//);

    // Modal should be gone, full detail page visible
    await expect(
      page.locator('[data-testid="product-modal"]'),
    ).not.toBeVisible();
    await expect(
      page.locator('[data-testid="segment-metadata"]'),
    ).toBeVisible();

    // Step 3: Navigate back - should show modal again with index background
    await goBack(page);
    await expect(page.locator('[data-testid="product-modal"]')).toBeVisible();

    // Background should still show index content (not detail page)
    await expect(
      page.locator('[data-testid="product-link-product-b"]'),
    ).toBeVisible();

    // Step 4: Close modal by navigating back again
    await goBack(page);
    await expect(page.locator('[data-testid="product-modal"]')).not.toBeVisible(
      {
        timeout: 5000,
      },
    );
    await expect(page).toHaveURL(/\/$/);

    // Index content should be visible
    await expect(
      page.locator('[data-testid="product-link-product-a"]'),
    ).toBeVisible();

    // Step 5: Click the same product again
    await productLink.click();
    await expect(page.locator('[data-testid="product-modal"]')).toBeVisible();

    // BUG: Background should show index content, NOT the detail page
    // The detail page has segment-metadata, index has the product list
    await expect(
      page.locator('[data-testid="segment-metadata"]'),
    ).not.toBeVisible();
    await expect(
      page.locator('[data-testid="product-link-product-b"]'),
    ).toBeVisible();
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
    const incrementButton = page.locator(
      '[data-testid="modal-quantity-control"] button:has-text("+")',
    );
    await incrementButton.click();

    // Immediately navigate back before action completes
    await goBack(page);

    // Wait for stale responses
    await page.waitForTimeout(600);

    // Index content should still be visible
    await expect(page.locator('[data-testid="page-title"]')).toBeVisible();

    // Modal should be gone
    await expect(
      page.locator('[data-testid="product-modal"]'),
    ).not.toBeVisible();
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
    await expect(
      page.locator('[data-testid="segment-metadata"]'),
    ).toBeVisible();

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
    await expect(
      page.locator('[data-testid="segment-metadata"]'),
    ).toBeVisible();

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
    await expect(
      page.locator('[data-testid="product-modal"]'),
    ).not.toBeVisible();

    // Navigate to a different product
    const productLink2 = page.locator('[data-testid="product-link-product-b"]');
    await productLink2.click();
    await expect(page.locator('[data-testid="product-modal"]')).toBeVisible();

    // Navigate back to index
    await goBack(page);

    // Index content should be restored
    await expect(page.locator('[data-testid="page-title"]')).toBeVisible();

    // Modal should be gone on index
    await expect(
      page.locator('[data-testid="product-modal"]'),
    ).not.toBeVisible();
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
      '[data-testid="modal-quantity-control"] [data-testid="quantity-display"]',
    );
    const initialQuantity = parseInt(
      (await modalQuantityDisplay.textContent()) || "0",
    );

    // 2. Increment quantity in modal (action)
    const modalIncrementButton = page.locator(
      '[data-testid="modal-quantity-control"] button:has-text("+")',
    );
    await modalIncrementButton.click();

    // Wait for optimistic update
    await expect(modalQuantityDisplay).toHaveText(String(initialQuantity + 1));

    // 3. Go to details page
    await page.locator('[data-testid="view-full-details"]').click();
    await expect(
      page.locator('[data-testid="segment-metadata"]'),
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="product-modal"]'),
    ).not.toBeVisible();

    // 4. Click add to cart on detail page and wait for it to complete
    const addToCartButton = page.locator('[data-testid="add-to-cart-btn"]');
    await addToCartButton.click();
    await expect(
      page.locator('[data-testid="add-to-cart-btn-result"]'),
    ).toBeVisible();

    // 5. Go back - should return to intercept modal
    await goBack(page);
    await expect(page.locator('[data-testid="product-modal"]')).toBeVisible();

    // 6. Verify quantity was updated after revalidation
    // The quantity should reflect the add to cart action (initialQuantity + 1 from modal + 1 from add to cart = initialQuantity + 2)
    await expect(modalQuantityDisplay).toHaveText(String(initialQuantity + 2), {
      timeout: 3000,
    });
  });

  test("should not show modal on detail page after back to intercept and forward to detail", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/"));
    await waitForHydration(page);

    // 1. Click product to open modal (intercept)
    const productLink = page.locator('[data-testid="product-link-product-a"]');
    await productLink.click();
    await expect(page.locator('[data-testid="product-modal"]')).toBeVisible();

    // 2. Go to details page
    await page.locator('[data-testid="view-full-details"]').click();
    await expect(
      page.locator('[data-testid="segment-metadata"]'),
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="product-modal"]'),
    ).not.toBeVisible();

    // 3. Do an action on detail page (increment quantity)
    const incrementButton = page.locator(
      '[data-testid="quantity-control"] button:has-text("+")',
    );
    await incrementButton.click();
    // Wait for action to complete
    await page.waitForTimeout(500);

    // 4. Go back to intercept modal
    await goBack(page);
    await expect(page.locator('[data-testid="product-modal"]')).toBeVisible();
    await expect(
      page.locator('[data-testid="segment-metadata"]'),
    ).not.toBeVisible();

    // 5. Go to details page again via View Full Details
    await page.locator('[data-testid="view-full-details"]').click();
    await expect(
      page.locator('[data-testid="segment-metadata"]'),
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="product-modal"]'),
    ).not.toBeVisible();

    // 6. Click add to cart on detail page and wait for it to complete
    const addToCartButton = page.locator('[data-testid="add-to-cart-btn"]');
    await addToCartButton.click();
    await expect(
      page.locator('[data-testid="add-to-cart-btn-result"]'),
    ).toBeVisible();

    // 7. Modal should NOT appear - we're on detail page, not intercept
    await expect(
      page.locator('[data-testid="product-modal"]'),
    ).not.toBeVisible();
    // Detail page should still be visible
    await expect(
      page.locator('[data-testid="segment-metadata"]'),
    ).toBeVisible();
  });
});

test.describe("conditional-intercept-when", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });

  test("should show modal when navigating from index (when condition met)", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // Start on index page
    await page.goto(f.url("/"));
    await waitForHydration(page);

    // Click product link from index
    const productLink = page.locator('[data-testid="product-link-product-a"]');
    await productLink.click();

    // Should show modal (when condition: from.pathname === "/" is true)
    await expect(page.locator('[data-testid="product-modal"]')).toBeVisible();
    await expect(
      page.locator('[data-testid="intercept-indicator"]'),
    ).toBeVisible();

    // URL should change to product URL
    await expect(page).toHaveURL(/\/product\//);
  });

  test("should NOT show modal when navigating from blog (when condition not met)", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // Start on blog page
    await page.goto(f.url("/blog"));
    await waitForHydration(page);

    // Verify we're on blog page
    await expect(page.locator('[data-testid="blog-title"]')).toBeVisible();

    // Click product link from blog
    const productLink = page.locator('[data-testid="blog-product-link"]');
    await productLink.click();

    // Should NOT show modal (when condition: from.pathname === "/" is false)
    await expect(
      page.locator('[data-testid="product-modal"]'),
    ).not.toBeVisible();

    // Should show full product detail page
    await expect(
      page.locator('[data-testid="product-detail-page"]'),
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="segment-metadata"]'),
    ).toBeVisible();

    // URL should be product URL
    await expect(page).toHaveURL(/\/product\//);
  });

  test("should preserve modal during action revalidation (when skipped for actions)", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // Start on index page
    await page.goto(f.url("/"));
    await waitForHydration(page);

    // Click product to open modal
    const productLink = page.locator('[data-testid="product-link-product-a"]');
    await productLink.click();
    await expect(page.locator('[data-testid="product-modal"]')).toBeVisible();

    // Get initial quantity
    const modalQuantityDisplay = page.locator(
      '[data-testid="modal-quantity-control"] [data-testid="quantity-display"]',
    );
    const initialQuantity = parseInt(
      (await modalQuantityDisplay.textContent()) || "0",
    );

    // Perform action in modal (increment quantity)
    const incrementButton = page.locator(
      '[data-testid="modal-quantity-control"] button:has-text("+")',
    );
    await incrementButton.click();

    // Wait for action to complete
    await expect(modalQuantityDisplay).toHaveText(String(initialQuantity + 1));

    // Modal should still be visible (when() was skipped during action revalidation)
    await expect(page.locator('[data-testid="product-modal"]')).toBeVisible();
    await expect(
      page.locator('[data-testid="intercept-indicator"]'),
    ).toBeVisible();
  });

  test("should show full page on direct navigation regardless of when condition", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // Navigate directly to product URL (document load / hard navigation)
    await page.goto(f.url("/product/product-a"));
    await waitForHydration(page);

    // Should NOT show modal - hard navigation always bypasses intercept
    await expect(
      page.locator('[data-testid="product-modal"]'),
    ).not.toBeVisible();

    // Should show full product detail page
    await expect(
      page.locator('[data-testid="product-detail-page"]'),
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="segment-metadata"]'),
    ).toBeVisible();
  });

  test("should show modal after navigating back to index then to product", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // Start on blog page
    await page.goto(f.url("/blog"));
    await waitForHydration(page);

    // Navigate to product from blog (no modal)
    const productLink = page.locator('[data-testid="blog-product-link"]');
    await productLink.click();
    await expect(
      page.locator('[data-testid="product-modal"]'),
    ).not.toBeVisible();
    await expect(
      page.locator('[data-testid="product-detail-page"]'),
    ).toBeVisible();

    // Navigate to index
    await page.locator('[data-testid="back-link"]').click();
    await expect(page.locator('[data-testid="index-page"]')).toBeVisible();

    // Now navigate to product from index (should show modal)
    const indexProductLink = page.locator(
      '[data-testid="product-link-product-a"]',
    );
    await indexProductLink.click();
    await expect(page.locator('[data-testid="product-modal"]')).toBeVisible();
    await expect(
      page.locator('[data-testid="intercept-indicator"]'),
    ).toBeVisible();
  });
});

/**
 * Production build tests for navigation functionality
 */
test.describe("navigation (production)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "build",
  });

  test.setTimeout(120000);

  test("basic navigation works in production", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/"));
    await waitForHydration(page);

    // Navigate to product
    await page.locator('[data-testid="product-link-product-a"]').click();

    // Modal should appear (intercept)
    await expect(page.locator('[data-testid="product-modal"]')).toBeVisible();

    // URL should change
    await expect(page).toHaveURL(/\/product\/product-a/);
  });

  test("intercept navigation shows modal in production", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/"));
    await waitForHydration(page);

    // Click product link
    await page.locator('[data-testid="product-link-product-a"]').click();

    // Modal should show
    await expect(page.locator('[data-testid="product-modal"]')).toBeVisible();

    // Navigate to full details
    await page.locator('[data-testid="view-full-details"]').click();

    // Should see full product page
    await expect(
      page.locator('[data-testid="segment-metadata"]'),
    ).toBeVisible();

    // Modal should be gone after navigating to full details
    await expect(
      page.locator('[data-testid="product-modal"]'),
    ).not.toBeVisible();
  });

  test("back navigation works in production", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/"));
    await waitForHydration(page);

    // Navigate to product modal
    await page.locator('[data-testid="product-link-product-a"]').click();
    await expect(page.locator('[data-testid="product-modal"]')).toBeVisible();

    // Go to full details
    await page.locator('[data-testid="view-full-details"]').click();
    await expect(
      page.locator('[data-testid="segment-metadata"]'),
    ).toBeVisible();

    // Back should show modal
    await page.goBack();
    await expect(page.locator('[data-testid="product-modal"]')).toBeVisible();

    // Back again should show index
    await page.goBack();
    await expect(page).toHaveURL(/\/$/);

    // Modal should be gone on index
    await expect(
      page.locator('[data-testid="product-modal"]'),
    ).not.toBeVisible();
  });

  test("hard navigation to product shows full page in production", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // Direct navigation (hard) to product
    await page.goto(f.url("/product/product-a"));
    await waitForHydration(page);

    // Should show full product page, not modal
    await expect(
      page.locator('[data-testid="segment-metadata"]'),
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="product-modal"]'),
    ).not.toBeVisible();
  });

  test("loader revalidation works after action in production", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/product/product-a"));
    await waitForHydration(page);

    // Get initial quantity
    const quantityEl = page.locator('[data-testid="quantity-display"]');
    const initialQuantity = await quantityEl.textContent();

    // Add to cart
    await page.locator('[data-testid="add-to-cart-btn"]').click();

    // Wait for quantity to update (revalidation)
    await expect(async () => {
      const newQuantity = await quantityEl.textContent();
      expect(newQuantity).not.toEqual(initialQuantity);
    }).toPass({ timeout: 5000 });
  });
});
