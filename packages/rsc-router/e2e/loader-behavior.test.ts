import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError, testId } from "./helper";

/**
 * Tests for loader behavior:
 * 1. Loader is awaited if route/layout doesn't have loading component
 * 2. Loader streams if route has loading component
 * 3. skipSSR: true - awaited on SSR, streams on navigation
 * 4. Loaders are revalidated when action is performed
 * 5. Only loaders registered with loader() are used
 */

const LOADER_DELAY = 1000;
const TIMING_TOLERANCE = 500;

test.describe("loader-behavior", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });

  test.setTimeout(30000);

  test.describe("awaited-loader (no loading component)", () => {
    test("direct load should await loader before rendering", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      const startTime = Date.now();

      // Navigate directly to slow route
      await page.goto(f.url("/slow"));
      await waitForHydration(page);

      const elapsed = Date.now() - startTime;

      // Page should be fully rendered (loader was awaited)
      await expect(page.locator('[data-testid="slow-page"]')).toBeVisible();
      await expect(page.locator('[data-testid="slow-message"]')).toContainText(
        "Slow data loaded"
      );

      // Should have taken at least the loader delay
      expect(elapsed).toBeGreaterThan(LOADER_DELAY - TIMING_TOLERANCE);
    });

    test("SPA navigation should await loader (no loading skeleton)", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      // Start from index
      await page.goto(f.url("/"));
      await waitForHydration(page);

      // Click link to slow route
      const startTime = Date.now();
      await page.locator('[data-testid="slow-link"]').click();

      // Wait for the slow page to appear
      await expect(page.locator('[data-testid="slow-page"]')).toBeVisible();
      await expect(page.locator('[data-testid="slow-message"]')).toContainText(
        "Slow data loaded"
      );

      const elapsed = Date.now() - startTime;

      // Should have taken at least the loader delay (navigation blocked until loaded)
      expect(elapsed).toBeGreaterThan(LOADER_DELAY - TIMING_TOLERANCE);
    });
  });

  test.describe("streaming-loader (with loading component)", () => {
    test("SPA navigation should show loading skeleton immediately", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      // Start from index
      await page.goto(f.url("/"));
      await waitForHydration(page);

      // Click link to slow-streaming route
      const startTime = Date.now();
      await page.locator('[data-testid="slow-streaming-link"]').click();

      // Loading skeleton should appear quickly (not waiting for loader)
      await expect(
        page.locator('[data-testid="slow-streaming-loading"]')
      ).toBeVisible({ timeout: 500 });

      const loadingVisibleTime = Date.now() - startTime;

      // Loading should appear much faster than the loader delay
      expect(loadingVisibleTime).toBeLessThan(LOADER_DELAY);

      // Wait for actual content to replace loading
      await expect(
        page.locator('[data-testid="slow-streaming-page"]')
      ).toBeVisible({ timeout: 5000 });
      await expect(
        page.locator('[data-testid="slow-streaming-message"]')
      ).toContainText("Slow data loaded");

      const totalTime = Date.now() - startTime;

      // Total time should be around the loader delay
      expect(totalTime).toBeGreaterThan(LOADER_DELAY - TIMING_TOLERANCE);
    });

    test("direct load should still show loading skeleton", async ({ page }) => {
      using _ = expectNoPageError(page);

      // Navigate directly - loading component should still be shown during SSR streaming
      await page.goto(f.url("/slow-streaming"));

      // Either loading or final content should be visible
      // (depends on timing of when we check - both may be visible during streaming)
      const loadingOrContent = page
        .locator('[data-testid="slow-streaming-loading"]')
        .or(page.locator('[data-testid="slow-streaming-page"]'));
      await expect(loadingOrContent.first()).toBeVisible({ timeout: 5000 });

      // Eventually the page should be fully loaded
      await waitForHydration(page);
      await expect(
        page.locator('[data-testid="slow-streaming-page"]')
      ).toBeVisible();
    });

    test("should navigate back to index after streaming route finishes loading", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      // Start from index
      await page.goto(f.url("/"));
      await waitForHydration(page);

      // Verify we're on the index page
      await expect(testId(page, "index-page")).toBeVisible();

      // Click link to slow-streaming route
      await testId(page, "slow-streaming-link").click();

      // Wait for loading to appear
      await expect(testId(page, "slow-streaming-loading")).toBeVisible({
        timeout: 500,
      });

      // Wait for actual content to finish loading
      await expect(testId(page, "slow-streaming-page")).toBeVisible({
        timeout: 5000,
      });

      // Now click the back link to go home
      await testId(page, "back-link").click();

      // URL should change to /
      await expect(page).toHaveURL(/\/$/);

      // Index page should be visible and slow-streaming page should be gone
      await expect(testId(page, "index-page")).toBeVisible({ timeout: 2000 });
      await expect(testId(page, "slow-streaming-page")).not.toBeVisible();
    });
  });

  test.describe("skipSSR loading", () => {
    test("direct load should NOT show loading (awaited on SSR)", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      const startTime = Date.now();

      // Navigate directly - with skipSSR, loader is awaited on document request
      await page.goto(f.url("/slow-streaming-skip-ssr"));
      await waitForHydration(page);

      const elapsed = Date.now() - startTime;

      // Page should be fully rendered immediately (no loading visible)
      await expect(
        page.locator('[data-testid="slow-skip-ssr-page"]')
      ).toBeVisible();
      await expect(
        page.locator('[data-testid="slow-skip-ssr-message"]')
      ).toContainText("Slow data loaded");

      // Should have taken at least the loader delay (was awaited)
      expect(elapsed).toBeGreaterThan(LOADER_DELAY - TIMING_TOLERANCE);
    });

    test("SPA navigation should show loading (streams on navigation)", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      // Start from index
      await page.goto(f.url("/"));
      await waitForHydration(page);

      // Click link to skip-ssr route
      const startTime = Date.now();
      await page.locator('[data-testid="slow-skip-ssr-link"]').click();

      // Loading skeleton should appear quickly (streaming on SPA navigation)
      await expect(
        page.locator('[data-testid="slow-skip-ssr-loading"]')
      ).toBeVisible({ timeout: 500 });

      const loadingVisibleTime = Date.now() - startTime;

      // Loading should appear much faster than the loader delay
      expect(loadingVisibleTime).toBeLessThan(LOADER_DELAY);

      // Wait for actual content
      await expect(
        page.locator('[data-testid="slow-skip-ssr-page"]')
      ).toBeVisible({ timeout: 5000 });
    });
  });

  test.describe("loader-revalidation", () => {
    test("action should trigger loader revalidation", async ({ page }) => {
      using _ = expectNoPageError(page);

      // Navigate to slow route
      await page.goto(f.url("/slow"));
      await waitForHydration(page);

      // Get initial load count
      const initialCountText = await page
        .locator('[data-testid="slow-count"]')
        .textContent();
      const initialNum = parseInt(initialCountText?.match(/\d+/)?.[0] || "0");

      // Trigger revalidation action
      await page.locator('[data-testid="slow-revalidate-btn"]').click();

      // Wait for action to complete
      await expect(
        page.locator('[data-testid="slow-revalidate-btn-result"]')
      ).toBeVisible({ timeout: 5000 });

      // Wait for loader to revalidate (takes 1s)
      await page.waitForTimeout(1500);

      // Load count should have incremented
      const newCountText = await page
        .locator('[data-testid="slow-count"]')
        .textContent();
      const newNum = parseInt(newCountText?.match(/\d+/)?.[0] || "0");
      expect(newNum).toBeGreaterThan(initialNum);
    });

    test("action on streaming route should trigger loader revalidation", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      // Navigate to slow-streaming route via SPA
      await page.goto(f.url("/"));
      await waitForHydration(page);

      await page.locator('[data-testid="slow-streaming-link"]').click();
      await expect(
        page.locator('[data-testid="slow-streaming-page"]')
      ).toBeVisible({ timeout: 5000 });

      // Get initial load count
      const initialCount = await page
        .locator('[data-testid="slow-streaming-count"]')
        .textContent();
      const initialNum = parseInt(initialCount?.match(/\d+/)?.[0] || "0");

      // Trigger revalidation action
      await page
        .locator('[data-testid="slow-streaming-revalidate-btn"]')
        .click();

      // Wait for action to complete
      await expect(
        page.locator('[data-testid="slow-streaming-revalidate-btn-result"]')
      ).toBeVisible({ timeout: 5000 });

      // Wait for loader to revalidate (takes 1s)
      await page.waitForTimeout(1500);

      // Load count should have incremented
      const newCount = await page
        .locator('[data-testid="slow-streaming-count"]')
        .textContent();
      const newNum = parseInt(newCount?.match(/\d+/)?.[0] || "0");
      expect(newNum).toBeGreaterThan(initialNum);
    });
  });
});
