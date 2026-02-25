import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError, goBack } from "./helper";

/**
 * Tests for streaming actions that verify:
 * 1. UI is streamed correctly after specified seconds
 * 2. Actions work the same on document load vs SPA navigation
 * 3. React trees are consistent between document and partial render
 *
 * Uses isolated test app with streaming action:
 * - 1s initial delay (isPending)
 * - 2s streaming delay (Suspense fallback then result)
 * - Total ~3s until "Completed!" appears
 */

// Streaming action takes ~3000ms total (1s initial + 2s streaming)
const STREAMING_DELAY = 3000;
const TIMING_TOLERANCE = 1500; // Allow variance for streaming

test.describe("streaming-actions", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });

  // Increase timeout for streaming tests
  test.setTimeout(30000);

  test.describe("direct-load", () => {
    test("streaming action should show loading then complete", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      // Navigate directly to product detail page
      await page.goto(f.url("/product/product-a"));
      await waitForHydration(page);

      // Verify we're on detail page (not intercept)
      await expect(
        page.locator('[data-testid="segment-metadata"]'),
      ).toBeVisible();

      // Find streaming action button and status indicator
      const button = page.locator('[data-testid="streaming-btn"]');
      const actionStatus = page.locator(
        '[data-testid="StreamingActionStatus-action-status"]',
      );
      await expect(button).toBeVisible();
      await expect(actionStatus).toBeVisible();

      // Verify initial state is idle
      await expect(actionStatus).toContainText("idle");

      // Click to start streaming action
      await button.click();

      // Record start time
      const startTime = Date.now();

      // Verify state transitions to loading
      await expect(actionStatus).toContainText("loading", { timeout: 2000 });

      // Verify "Streaming..." loading state appears in the result area
      await expect(
        page.locator('[data-testid="streaming-btn-loading"]'),
      ).toContainText("Streaming...", { timeout: 5000 });

      // Verify state transitions to streaming
      await expect(actionStatus).toContainText("streaming", { timeout: 5000 });

      // Wait for the streaming result to show "Completed!"
      await expect(
        page.locator('[data-testid="streaming-btn-result"]'),
      ).toContainText("Completed", { timeout: 10000 });

      // Verify state returns to idle after completion
      await expect(actionStatus).toContainText("idle", { timeout: 5000 });

      // Verify timing - streaming completes after ~3000ms
      const elapsed = Date.now() - startTime;
      expect(elapsed).toBeGreaterThan(STREAMING_DELAY - TIMING_TOLERANCE);

      // Page should remain stable
      await expect(
        page.locator('[data-testid="segment-metadata"]'),
      ).toBeVisible();
    });
  });

  test.describe("spa-navigation", () => {
    test("streaming action should work after SPA navigation", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      // Start from index
      await page.goto(f.url("/"));
      await waitForHydration(page);

      // Navigate to product via SPA (intercept)
      const productLink = page.locator(
        '[data-testid="product-link-product-a"]',
      );
      await productLink.click();
      await expect(page.locator('[data-testid="product-modal"]')).toBeVisible();

      // Go to full details (still SPA navigation)
      await page.locator('[data-testid="view-full-details"]').click();
      await expect(
        page.locator('[data-testid="segment-metadata"]'),
      ).toBeVisible();

      // Find streaming action button
      const button = page.locator('[data-testid="streaming-btn"]');
      await expect(button).toBeVisible();

      // Record start time
      const startTime = Date.now();

      // Click to start streaming action
      await button.click();

      // Wait for the streaming result to show "Completed!"
      await expect(
        page.locator('[data-testid="streaming-btn-result"]'),
      ).toContainText("Completed", { timeout: 10000 });

      // Verify timing
      const elapsed = Date.now() - startTime;
      expect(elapsed).toBeGreaterThan(STREAMING_DELAY - TIMING_TOLERANCE);

      // Page should remain stable
      await expect(
        page.locator('[data-testid="segment-metadata"]'),
      ).toBeVisible();
    });
  });

  test.describe("consistency", () => {
    test("streaming action should complete successfully in both paths", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      // === Test on document load ===
      await page.goto(f.url("/product/product-a"));
      await waitForHydration(page);
      await expect(
        page.locator('[data-testid="segment-metadata"]'),
      ).toBeVisible();

      let button = page.locator('[data-testid="streaming-btn"]');

      await button.click();
      await expect(
        page.locator('[data-testid="streaming-btn-result"]'),
      ).toContainText("Completed", { timeout: 10000 });

      // === Test on SPA navigation ===
      await page.goto(f.url("/"));
      await waitForHydration(page);

      // Navigate via SPA
      const productLink = page.locator(
        '[data-testid="product-link-product-a"]',
      );
      await productLink.click();
      await expect(page.locator('[data-testid="product-modal"]')).toBeVisible();
      await page.locator('[data-testid="view-full-details"]').click();
      await expect(
        page.locator('[data-testid="segment-metadata"]'),
      ).toBeVisible();

      button = page.locator('[data-testid="streaming-btn"]');

      await button.click();
      await expect(
        page.locator('[data-testid="streaming-btn-result"]'),
      ).toContainText("Completed", { timeout: 10000 });
    });
  });
});

test.describe("action-form-patterns", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });

  test("add to cart action should work on document load", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/product/product-a"));
    await waitForHydration(page);

    await expect(
      page.locator('[data-testid="segment-metadata"]'),
    ).toBeVisible();

    // Find add to cart button
    const button = page.locator('[data-testid="add-to-cart-btn"]');
    await expect(button).toBeVisible();

    // Click should work without errors
    await button.click();

    // Wait for result message
    await expect(
      page.locator('[data-testid="add-to-cart-btn-result"]'),
    ).toBeVisible();

    // Page should remain stable
    await expect(
      page.locator('[data-testid="segment-metadata"]'),
    ).toBeVisible();
  });

  test("add to cart action should work after SPA navigation", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // Start from index
    await page.goto(f.url("/"));
    await waitForHydration(page);

    // Navigate via SPA
    const productLink = page.locator('[data-testid="product-link-product-a"]');
    await productLink.click();
    await expect(page.locator('[data-testid="product-modal"]')).toBeVisible();
    await page.locator('[data-testid="view-full-details"]').click();
    await expect(
      page.locator('[data-testid="segment-metadata"]'),
    ).toBeVisible();

    // Find add to cart button
    const button = page.locator('[data-testid="add-to-cart-btn"]');
    await button.click();

    // Wait for result message
    await expect(
      page.locator('[data-testid="add-to-cart-btn-result"]'),
    ).toBeVisible();

    // Page should remain stable
    await expect(
      page.locator('[data-testid="segment-metadata"]'),
    ).toBeVisible();
  });

  test("quantity control should work on document load", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/product/product-a"));
    await waitForHydration(page);

    await expect(
      page.locator('[data-testid="segment-metadata"]'),
    ).toBeVisible();

    // Find quantity control
    const incrementButton = page.locator(
      '[data-testid="quantity-control"] button:has-text("+")',
    );

    await expect(incrementButton).toBeVisible();

    // Click increment
    await incrementButton.click();

    // Wait for update
    await page.waitForTimeout(600);

    // Page should remain stable
    await expect(
      page.locator('[data-testid="segment-metadata"]'),
    ).toBeVisible();
  });

  test("quantity control should work after SPA navigation", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/"));
    await waitForHydration(page);

    // Navigate via SPA
    const productLink = page.locator('[data-testid="product-link-product-a"]');
    await productLink.click();
    await expect(page.locator('[data-testid="product-modal"]')).toBeVisible();
    await page.locator('[data-testid="view-full-details"]').click();
    await expect(
      page.locator('[data-testid="segment-metadata"]'),
    ).toBeVisible();

    // Find quantity control
    const incrementButton = page.locator(
      '[data-testid="quantity-control"] button:has-text("+")',
    );
    await incrementButton.click();

    // Wait for update
    await page.waitForTimeout(600);

    // Page should remain stable
    await expect(
      page.locator('[data-testid="segment-metadata"]'),
    ).toBeVisible();
  });
});
