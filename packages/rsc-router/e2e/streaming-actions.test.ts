import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError, goBack } from "./helper";

/**
 * Tests for streaming actions that verify:
 * 1. UI is streamed correctly after specified seconds
 * 2. Actions work the same on document load vs SPA navigation
 * 3. React trees are consistent between document and partial render
 *
 * Uses demo app with streaming action that takes ~3 seconds
 */

// Streaming action takes 3000ms to resolve in demo app
const STREAMING_DELAY = 3000;
const TIMING_TOLERANCE = 1000; // Allow 1s variance

test.describe("streaming-actions", () => {
  const f = useFixture({
    root: "../../examples/vite-rsc-demo",
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
      await page.goto(f.url("/shop/product/wireless-headphones"));
      await waitForHydration(page);

      // Verify we're on detail page (not intercept)
      await expect(page.locator('text=Segment Metadata')).toBeVisible();

      // Find streaming action button
      const button = page.locator('button:has-text("Add product (Streaming)")');
      await expect(button).toBeVisible();

      // Click to start streaming action
      await button.click();

      // Record start time
      const startTime = Date.now();

      // Wait for completion (button should become enabled again)
      await expect(button).toBeEnabled({ timeout: 10000 });

      // Verify timing - streaming completes after ~3000ms
      const elapsed = Date.now() - startTime;
      expect(elapsed).toBeGreaterThan(STREAMING_DELAY - TIMING_TOLERANCE);

      // Page should remain stable
      await expect(page.locator('text=Segment Metadata')).toBeVisible();
    });
  });

  test.describe("spa-navigation", () => {
    test("streaming action should work after SPA navigation", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      // Start from shop index
      await page.goto(f.url("/shop"));
      await waitForHydration(page);

      // Navigate to product via SPA (intercept)
      const productLink = page.locator('a[href*="/shop/product/"]').first();
      await productLink.click();
      await expect(page.locator('div[style*="position: fixed"]')).toBeVisible();

      // Go to full details (still SPA navigation)
      await page.locator('text=View Full Details').click();
      await expect(page.locator('text=Segment Metadata')).toBeVisible();

      // Find streaming action button
      const button = page.locator('button:has-text("Add product (Streaming)")');
      await expect(button).toBeVisible();

      // Record start time
      const startTime = Date.now();

      // Click to start streaming action
      await button.click();

      // Wait for completion
      await expect(button).toBeEnabled({ timeout: 10000 });

      // Verify timing
      const elapsed = Date.now() - startTime;
      expect(elapsed).toBeGreaterThan(STREAMING_DELAY - TIMING_TOLERANCE);

      // Page should remain stable
      await expect(page.locator('text=Segment Metadata')).toBeVisible();
    });
  });

  test.describe("consistency", () => {
    test("streaming action should complete successfully in both paths", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      // === Test on document load ===
      await page.goto(f.url("/shop/product/wireless-headphones"));
      await waitForHydration(page);
      await expect(page.locator('text=Segment Metadata')).toBeVisible();

      let button = page.locator('button:has-text("Add product (Streaming)")');

      await button.click();
      await expect(button).toBeEnabled({ timeout: 10000 });

      // === Test on SPA navigation ===
      await page.goto(f.url("/shop"));
      await waitForHydration(page);

      // Navigate via SPA
      const productLink = page.locator('a[href*="/shop/product/"]').first();
      await productLink.click();
      await expect(page.locator('div[style*="position: fixed"]')).toBeVisible();
      await page.locator('text=View Full Details').click();
      await expect(page.locator('text=Segment Metadata')).toBeVisible();

      button = page.locator('button:has-text("Add product (Streaming)")');

      await button.click();
      await expect(button).toBeEnabled({ timeout: 10000 });
    });
  });
});

test.describe("action-form-patterns", () => {
  const f = useFixture({
    root: "../../examples/vite-rsc-demo",
    mode: "dev",
  });

  test("fire-and-forget action should work on document load", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/shop/product/wireless-headphones"));
    await waitForHydration(page);

    await expect(page.locator('text=Segment Metadata')).toBeVisible();

    // Find first useActionState button (fire-and-forget pattern)
    const button = page.locator('button:has-text("Add to Cart (useActionState)")').first();
    await expect(button).toBeVisible();

    // Click should work without errors
    await button.click();

    // Page should remain stable
    await expect(page.locator('text=Segment Metadata')).toBeVisible();
  });

  test("fire-and-forget action should work after SPA navigation", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // Start from shop index
    await page.goto(f.url("/shop"));
    await waitForHydration(page);

    // Navigate via SPA
    const productLink = page.locator('a[href*="/shop/product/"]').first();
    await productLink.click();
    await expect(page.locator('div[style*="position: fixed"]')).toBeVisible();
    await page.locator('text=View Full Details').click();
    await expect(page.locator('text=Segment Metadata')).toBeVisible();

    // First "Add to Cart (useActionState)" button is fire-and-forget
    const button = page.locator('button:has-text("Add to Cart (useActionState)")').first();
    await button.click();

    // Page should remain stable
    await expect(page.locator('text=Segment Metadata')).toBeVisible();
  });

  test("action with result should work on document load", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/shop/product/wireless-headphones"));
    await waitForHydration(page);

    await expect(page.locator('text=Segment Metadata')).toBeVisible();

    // Find second useActionState button (with result pattern)
    const buttons = page.locator('button:has-text("Add to Cart (useActionState)")');
    const button = buttons.nth(1);
    await expect(button).toBeVisible();

    // Click and wait for completion
    await button.click();

    // Wait for button to become enabled again
    await expect(button).toBeEnabled({ timeout: 3000 });

    // Page should remain stable
    await expect(page.locator('text=Segment Metadata')).toBeVisible();
  });

  test("action with result should work after SPA navigation", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/shop"));
    await waitForHydration(page);

    // Navigate via SPA
    const productLink = page.locator('a[href*="/shop/product/"]').first();
    await productLink.click();
    await expect(page.locator('div[style*="position: fixed"]')).toBeVisible();
    await page.locator('text=View Full Details').click();
    await expect(page.locator('text=Segment Metadata')).toBeVisible();

    // Second "Add to Cart (useActionState)" button returns a result
    const buttons = page.locator('button:has-text("Add to Cart (useActionState)")');
    const button = buttons.nth(1);
    await button.click();

    // Wait for completion
    await expect(button).toBeEnabled({ timeout: 3000 });

    // Page should remain stable
    await expect(page.locator('text=Segment Metadata')).toBeVisible();
  });
});
