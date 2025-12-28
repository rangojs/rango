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
    await expect(page.locator('[data-testid="segment-metadata"]')).toBeVisible();
    await expect(page.locator('[data-testid="product-modal"]')).not.toBeVisible();

    // 3. Do an action on detail page (increment quantity)
    const incrementButton = page.locator(
      '[data-testid="quantity-control"] button:has-text("+")'
    );
    await incrementButton.click();
    // Wait for action to complete
    await page.waitForTimeout(500);

    // 4. Go back to intercept modal
    await goBack(page);
    await expect(page.locator('[data-testid="product-modal"]')).toBeVisible();
    await expect(
      page.locator('[data-testid="segment-metadata"]')
    ).not.toBeVisible();

    // 5. Go to details page again via View Full Details
    await page.locator('[data-testid="view-full-details"]').click();
    await expect(page.locator('[data-testid="segment-metadata"]')).toBeVisible();
    await expect(page.locator('[data-testid="product-modal"]')).not.toBeVisible();

    // 6. Click add to cart on detail page and wait for it to complete
    const addToCartButton = page.locator('[data-testid="add-to-cart-btn"]');
    await addToCartButton.click();
    await expect(
      page.locator('[data-testid="add-to-cart-btn-result"]')
    ).toBeVisible({ timeout: 5000 });

    // 7. Modal should NOT appear - we're on detail page, not intercept
    await expect(page.locator('[data-testid="product-modal"]')).not.toBeVisible();
    // Detail page should still be visible
    await expect(page.locator('[data-testid="segment-metadata"]')).toBeVisible();
  });
});

test.describe("navigation-state", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });

  test("should pass state to loading skeleton via Link state prop", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/"));
    await waitForHydration(page);

    // Click slow product link (has state prop with productName and productPrice)
    const slowProductLink = page.locator('[data-testid="slow-product-link"]');
    await slowProductLink.click();

    // Modal with loading skeleton should appear
    await expect(page.locator('[data-testid="slow-product-modal"]')).toBeVisible();
    await expect(page.locator('[data-testid="slow-modal-loading"]')).toBeVisible();

    // State should be available in skeleton - product name and price from Link state
    await expect(page.locator('[data-testid="slow-modal-state-name"]')).toHaveText("Slow Product A");
    await expect(page.locator('[data-testid="slow-modal-state-price"]')).toHaveText("$99");

    // Skeleton placeholders should NOT be visible since we have state
    await expect(page.locator('[data-testid="slow-modal-skeleton-name"]')).not.toBeVisible();
    await expect(page.locator('[data-testid="slow-modal-skeleton-price"]')).not.toBeVisible();
  });

  test("should show skeleton placeholders when Link has no state prop", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/"));
    await waitForHydration(page);

    // Click slow product link WITHOUT state prop
    const slowProductLink = page.locator('[data-testid="slow-product-link-no-state"]');
    await slowProductLink.click();

    // Modal with loading skeleton should appear
    await expect(page.locator('[data-testid="slow-product-modal"]')).toBeVisible();
    await expect(page.locator('[data-testid="slow-modal-loading"]')).toBeVisible();

    // Without state, skeleton placeholders should be visible
    await expect(page.locator('[data-testid="slow-modal-skeleton-name"]')).toBeVisible();
    await expect(page.locator('[data-testid="slow-modal-skeleton-price"]')).toBeVisible();

    // State elements should NOT be visible
    await expect(page.locator('[data-testid="slow-modal-state-name"]')).not.toBeVisible();
    await expect(page.locator('[data-testid="slow-modal-state-price"]')).not.toBeVisible();
  });

  test("should have state available in history after navigation completes", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/"));
    await waitForHydration(page);

    // Click slow product link with state
    const slowProductLink = page.locator('[data-testid="slow-product-link"]');
    await slowProductLink.click();

    // Wait for content to load
    await expect(page.locator('[data-testid="slow-modal-product-name"]')).toBeVisible({
      timeout: 5000,
    });

    // Check history state contains our passed state (typed location state uses __rsc_ls_ prefix)
    const state = await getHistoryState(page);
    expect(state?.__rsc_ls_slowProduct?.productName).toBe("Slow Product A");
    expect(state?.__rsc_ls_slowProduct?.productPrice).toBe(99);
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
    await expect(page.locator('[data-testid="intercept-indicator"]')).toBeVisible();

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
    await expect(page.locator('[data-testid="product-modal"]')).not.toBeVisible();

    // Should show full product detail page
    await expect(page.locator('[data-testid="product-detail-page"]')).toBeVisible();
    await expect(page.locator('[data-testid="segment-metadata"]')).toBeVisible();

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
      '[data-testid="modal-quantity-control"] [data-testid="quantity-display"]'
    );
    const initialQuantity = parseInt(
      (await modalQuantityDisplay.textContent()) || "0"
    );

    // Perform action in modal (increment quantity)
    const incrementButton = page.locator(
      '[data-testid="modal-quantity-control"] button:has-text("+")'
    );
    await incrementButton.click();

    // Wait for action to complete
    await expect(modalQuantityDisplay).toContainText(
      String(initialQuantity + 1)
    );

    // Modal should still be visible (when() was skipped during action revalidation)
    await expect(page.locator('[data-testid="product-modal"]')).toBeVisible();
    await expect(page.locator('[data-testid="intercept-indicator"]')).toBeVisible();
  });

  test("should show full page on direct navigation regardless of when condition", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // Navigate directly to product URL (document load / hard navigation)
    await page.goto(f.url("/product/product-a"));
    await waitForHydration(page);

    // Should NOT show modal - hard navigation always bypasses intercept
    await expect(page.locator('[data-testid="product-modal"]')).not.toBeVisible();

    // Should show full product detail page
    await expect(page.locator('[data-testid="product-detail-page"]')).toBeVisible();
    await expect(page.locator('[data-testid="segment-metadata"]')).toBeVisible();
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
    await expect(page.locator('[data-testid="product-modal"]')).not.toBeVisible();
    await expect(page.locator('[data-testid="product-detail-page"]')).toBeVisible();

    // Navigate to index
    await page.locator('[data-testid="back-link"]').click();
    await expect(page.locator('[data-testid="index-page"]')).toBeVisible();

    // Now navigate to product from index (should show modal)
    const indexProductLink = page.locator('[data-testid="product-link-product-a"]');
    await indexProductLink.click();
    await expect(page.locator('[data-testid="product-modal"]')).toBeVisible();
    await expect(page.locator('[data-testid="intercept-indicator"]')).toBeVisible();
  });
});

test.describe("intercept-loading-states", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });

  test("should show loading skeleton in modal while slow loader resolves", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/"));
    await waitForHydration(page);

    // Click slow product link to open modal with slow loader
    const slowProductLink = page.locator('[data-testid="slow-product-link"]');
    await slowProductLink.click();

    // Modal should appear immediately with loading skeleton
    await expect(page.locator('[data-testid="slow-product-modal"]')).toBeVisible();
    await expect(page.locator('[data-testid="slow-modal-loading"]')).toBeVisible();
    await expect(page.locator('[data-testid="slow-modal-skeleton"]')).toBeVisible();

    // Background index content should still be visible
    await expect(page.locator('[data-testid="page-title"]')).toBeVisible();

    // Wait for loader to resolve (2s delay) - content should appear
    await expect(page.locator('[data-testid="slow-modal-product-name"]')).toBeVisible({
      timeout: 5000,
    });

    // Loading skeleton should be gone
    await expect(page.locator('[data-testid="slow-modal-loading"]')).not.toBeVisible();

    // Modal should still show product content
    await expect(page.locator('[data-testid="slow-intercept-indicator"]')).toBeVisible();
  });

  test("should preserve background content while modal is loading", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/"));
    await waitForHydration(page);

    // Verify index content is visible before navigation
    await expect(page.locator('[data-testid="page-title"]')).toBeVisible();
    await expect(page.locator('[data-testid="product-list"]')).toBeVisible();

    // Click slow product link
    const slowProductLink = page.locator('[data-testid="slow-product-link"]');
    await slowProductLink.click();

    // Modal with loading state should appear
    await expect(page.locator('[data-testid="slow-product-modal"]')).toBeVisible();
    await expect(page.locator('[data-testid="slow-modal-loading"]')).toBeVisible();

    // Background should remain visible throughout loading
    await expect(page.locator('[data-testid="page-title"]')).toBeVisible();
    await expect(page.locator('[data-testid="product-list"]')).toBeVisible();

    // Wait for content to load
    await expect(page.locator('[data-testid="slow-modal-product-name"]')).toBeVisible({
      timeout: 5000,
    });

    // Background should still be visible after loading
    await expect(page.locator('[data-testid="page-title"]')).toBeVisible();
    await expect(page.locator('[data-testid="product-list"]')).toBeVisible();
  });

  test("should navigate back from loading modal", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/"));
    await waitForHydration(page);

    // Click slow product link
    const slowProductLink = page.locator('[data-testid="slow-product-link"]');
    await slowProductLink.click();

    // Modal with loading state should appear
    await expect(page.locator('[data-testid="slow-product-modal"]')).toBeVisible();
    await expect(page.locator('[data-testid="slow-modal-loading"]')).toBeVisible();

    // Navigate back while still loading
    await goBack(page);

    // Should be back on index without modal
    await expect(page).toHaveURL(/\/$/);
    await expect(page.locator('[data-testid="slow-product-modal"]')).not.toBeVisible();
    await expect(page.locator('[data-testid="page-title"]')).toBeVisible();
  });

  test("should show full page on direct navigation bypassing intercept with loading", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // Navigate directly to slow product URL (document load)
    await page.goto(f.url("/slow-product/slow-product-a"));
    await waitForHydration(page);

    // Should NOT show intercepted modal or loading skeleton
    await expect(page.locator('[data-testid="slow-product-modal"]')).not.toBeVisible();
    await expect(page.locator('[data-testid="slow-modal-loading"]')).not.toBeVisible();

    // Should show full product detail page
    await expect(page.locator('[data-testid="slow-product-detail-page"]')).toBeVisible();
    await expect(page.locator('[data-testid="slow-product-name"]')).toBeVisible();
  });

  test("should complete streaming action in intercepted modal", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/"));
    await waitForHydration(page);

    // Click slow product link to open modal
    const slowProductLink = page.locator('[data-testid="slow-product-link"]');
    await slowProductLink.click();

    // Wait for modal content to load (2s loader delay)
    await expect(page.locator('[data-testid="slow-modal-product-name"]')).toBeVisible({
      timeout: 5000,
    });

    // Click streaming action button
    const streamingButton = page.locator('[data-testid="slow-modal-streaming-btn"]');
    await streamingButton.click();

    // Button should be disabled while processing
    await expect(streamingButton).toBeDisabled();

    // Modal should remain visible during action
    await expect(page.locator('[data-testid="slow-product-modal"]')).toBeVisible();

    // Background should remain visible during action
    await expect(page.locator('[data-testid="page-title"]')).toBeVisible();

    // Wait for action to complete (3s delay)
    await expect(
      page.locator('[data-testid="slow-modal-streaming-btn-result"]')
    ).toContainText("Completed", { timeout: 10000 });

    // Modal should still be visible after action completes
    await expect(page.locator('[data-testid="slow-product-modal"]')).toBeVisible();
    await expect(page.locator('[data-testid="slow-modal-product-name"]')).toBeVisible();
  });

  test("should handle back navigation during streaming action in modal", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/"));
    await waitForHydration(page);

    // Click slow product link to open modal
    const slowProductLink = page.locator('[data-testid="slow-product-link"]');
    await slowProductLink.click();

    // Wait for modal content to load
    await expect(page.locator('[data-testid="slow-modal-product-name"]')).toBeVisible({
      timeout: 5000,
    });

    // Click streaming action button
    const streamingButton = page.locator('[data-testid="slow-modal-streaming-btn"]');
    await streamingButton.click();

    // Button should be disabled while processing
    await expect(streamingButton).toBeDisabled();

    // Navigate back while action is in progress
    await goBack(page);

    // Should be back on index without modal
    await expect(page).toHaveURL(/\/$/);
    await expect(page.locator('[data-testid="slow-product-modal"]')).not.toBeVisible();

    // Index should remain intact
    await expect(page.locator('[data-testid="page-title"]')).toBeVisible();
    await expect(page.locator('[data-testid="product-list"]')).toBeVisible();
  });

  test("should NOT show loading component during streaming action in modal", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/"));
    await waitForHydration(page);

    // Click slow product link to open modal
    const slowProductLink = page.locator('[data-testid="slow-product-link"]');
    await slowProductLink.click();

    // Wait for modal content to load (2s loader delay)
    await expect(page.locator('[data-testid="slow-modal-product-name"]')).toBeVisible({
      timeout: 5000,
    });

    // Loading skeleton should be gone after content loads
    await expect(page.locator('[data-testid="slow-modal-loading"]')).not.toBeVisible();

    // Click streaming action button
    const streamingButton = page.locator('[data-testid="slow-modal-streaming-btn"]');
    await streamingButton.click();

    // Button should be disabled while processing
    await expect(streamingButton).toBeDisabled();

    // During streaming action: loading component should NOT appear
    // The content should remain visible, not replaced by loading skeleton
    await expect(page.locator('[data-testid="slow-modal-loading"]')).not.toBeVisible();
    await expect(page.locator('[data-testid="slow-modal-product-name"]')).toBeVisible();

    // Wait a bit to ensure loading doesn't appear during action
    await page.waitForTimeout(500);
    await expect(page.locator('[data-testid="slow-modal-loading"]')).not.toBeVisible();

    // Wait for action to complete
    await expect(
      page.locator('[data-testid="slow-modal-streaming-btn-result"]')
    ).toContainText("Completed", { timeout: 10000 });

    // After action completes: still no loading component, content visible
    await expect(page.locator('[data-testid="slow-modal-loading"]')).not.toBeVisible();
    await expect(page.locator('[data-testid="slow-modal-product-name"]')).toBeVisible();
  });
});
