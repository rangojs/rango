import { expect, test } from "@playwright/test";
import { test as devTest, devURL } from "./dev-fixture";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError } from "./helper";

/**
 * Extract client age in seconds from text like "Client Age: 27s"
 */
function extractClientAge(text: string | null): number {
  const match = text?.match(/Client Age:\s*(\d+)s/);
  return match ? parseInt(match[1], 10) : 0;
}

/**
 * Extract server rendered timestamp from text
 */
function extractServerRendered(text: string | null): string {
  const match = text?.match(/Server Rendered:\s*([\d\-T:.Z]+)/);
  return match ? match[1] : "";
}

async function readClientAge(
  locator: import("@playwright/test").Locator,
): Promise<number> {
  return extractClientAge(await locator.textContent());
}

async function waitForClientAgeToExceed(
  locator: import("@playwright/test").Locator,
  baseline: number,
  delta = 1,
  timeout = 5000,
): Promise<number> {
  await expect
    .poll(() => readClientAge(locator), { timeout })
    .toBeGreaterThan(baseline + delta);

  return readClientAge(locator);
}

/**
 * Revalidation tests - verifies that query-param-only navigations don't cause
 * component remounting when revalidation returns false.
 *
 * These tests verify the fix for the issue where clientSegmentSet.delete()
 * was incorrectly removing route segments on all same-route navigations,
 * bypassing the revalidation logic.
 */
devTest.describe("revalidation-query-param-navigation", () => {
  devTest.describe("product-detail-page", () => {
    devTest(
      "should keep timer running when navigating between query params (tab=details to tab=reviews)",
      async ({ page, devServerURL }) => {
        using _ = expectNoPageError(page);

        // Navigate to product detail page with initial tab
        await page.goto(
          devURL(devServerURL, "/shop/product/wireless-headphones?tab=details"),
        );
        await waitForHydration(page);

        // Wait for product to load
        await expect(
          page.locator("h2:has-text('Wireless Headphones')"),
        ).toBeVisible({ timeout: 10000 });

        // Get the initial "Server Rendered" timestamp and "Client Age"
        // The format is: "Server Rendered: 2026-02-03T17:36:58.642Z | Client Age: 27s"
        const metadataLocator = page.locator(
          "text=/Server Rendered:.*Client Age:/",
        );
        await expect(metadataLocator).toBeVisible({ timeout: 5000 });

        const initialText = await metadataLocator.textContent();
        const initialServerRendered = extractServerRendered(initialText);
        const initialClientAge = extractClientAge(initialText);

        // Click the "Change to ?tab=reviews" link
        await page.locator('a:has-text("Change to ?tab=reviews")').click();

        // Wait for navigation to complete
        await expect(page).toHaveURL(/tab=reviews/);

        const newClientAge = await waitForClientAgeToExceed(
          metadataLocator,
          initialClientAge,
        );
        const newText = await metadataLocator.textContent();
        const newServerRendered = extractServerRendered(newText);

        // CRITICAL ASSERTIONS:
        // 1. Server Rendered timestamp should be the SAME (no server re-render)
        expect(newServerRendered).toBe(initialServerRendered);

        // 2. Client Age should have INCREASED (timer kept running, component wasn't re-mounted)
        // It should be at least 2 seconds more than initial (we waited ~3s total)
        expect(newClientAge).toBeGreaterThan(initialClientAge + 1);
      },
    );

    devTest(
      "should keep timer running when adding query param (no tab to tab=details)",
      async ({ page, devServerURL }) => {
        using _ = expectNoPageError(page);

        // Navigate to product detail page WITHOUT query params
        await page.goto(
          devURL(devServerURL, "/shop/product/wireless-headphones"),
        );
        await waitForHydration(page);

        // Wait for product to load
        await expect(
          page.locator("h2:has-text('Wireless Headphones')"),
        ).toBeVisible({ timeout: 10000 });

        // Get the initial "Client Age"
        const metadataLocator = page.locator(
          "text=/Server Rendered:.*Client Age:/",
        );
        await expect(metadataLocator).toBeVisible({ timeout: 5000 });

        const initialText = await metadataLocator.textContent();
        const initialClientAge = extractClientAge(initialText);

        // Click the "Add ?tab=details" link
        await page.locator('a:has-text("Add ?tab=details")').click();

        // Wait for navigation to complete
        await expect(page).toHaveURL(/tab=details/);

        const newClientAge = await waitForClientAgeToExceed(
          metadataLocator,
          initialClientAge,
        );

        // Client Age should have INCREASED (timer kept running)
        expect(newClientAge).toBeGreaterThan(initialClientAge + 1);
      },
    );

    devTest(
      "should reset timer when slug changes (different product)",
      async ({ page, devServerURL }) => {
        using _ = expectNoPageError(page);

        // Navigate to product detail page
        await page.goto(
          devURL(devServerURL, "/shop/product/wireless-headphones"),
        );
        await waitForHydration(page);

        // Wait for product to load
        await expect(
          page.locator("h2:has-text('Wireless Headphones')"),
        ).toBeVisible({ timeout: 10000 });

        // Get the Client Age before navigation
        const metadataLocator = page.locator(
          "text=/Server Rendered:.*Client Age:/",
        );
        const beforeClientAge = await waitForClientAgeToExceed(
          metadataLocator,
          0,
          2,
          6000,
        );

        // Should have at least 3 seconds
        expect(beforeClientAge).toBeGreaterThanOrEqual(3);

        // Click on "Running Shoes" link (slug changes)
        await page.locator('a:has-text("Running Shoes")').click();

        // Wait for new product to load
        await expect(page.locator("h2:has-text('Running Shoes')")).toBeVisible({
          timeout: 10000,
        });

        // Get the new Client Age - should be reset to low value
        const afterText = await metadataLocator.textContent();
        const afterClientAge = extractClientAge(afterText);

        // Client Age should be LESS than before (timer reset due to slug change)
        expect(afterClientAge).toBeLessThan(beforeClientAge);
      },
    );
  });

  devTest.describe("blog-post-page", () => {
    devTest(
      "should keep timer running when navigating between query params (?tab=1 to ?tab=2)",
      async ({ page, devServerURL }) => {
        using _ = expectNoPageError(page);

        // Navigate to blog post page
        await page.goto(devURL(devServerURL, "/blog/hello-world"));
        await waitForHydration(page);

        // Wait for page to load - check for the heading
        await expect(page.locator("text=Hello World").first()).toBeVisible({
          timeout: 5000,
        });

        // Get the initial "Server Rendered" timestamp and "Client Age"
        const metadataLocator = page.locator(
          "text=/Server Rendered:.*Client Age:/",
        );
        await expect(metadataLocator).toBeVisible({ timeout: 5000 });

        const initialText = await metadataLocator.textContent();
        const initialServerRendered = extractServerRendered(initialText);
        const initialClientAge = extractClientAge(initialText);

        // Click the "Add ?tab=1" link
        await page.locator('a:has-text("Add ?tab=1")').click();

        // Wait for URL to change
        await expect(page).toHaveURL(/tab=1/);

        const afterTab1ClientAge = await waitForClientAgeToExceed(
          metadataLocator,
          initialClientAge,
        );
        const afterTab1Text = await metadataLocator.textContent();
        const afterTab1ServerRendered = extractServerRendered(afterTab1Text);

        // CRITICAL ASSERTIONS:
        // 1. Server Rendered timestamp should be the SAME (no server re-render)
        expect(afterTab1ServerRendered).toBe(initialServerRendered);

        // 2. Client Age should have INCREASED (timer kept running)
        expect(afterTab1ClientAge).toBeGreaterThan(initialClientAge + 1);

        // Now click "Change to ?tab=2"
        await page.locator('a:has-text("Change to ?tab=2")').click();

        // Wait for URL to change
        await expect(page).toHaveURL(/tab=2/);

        const finalClientAge = await waitForClientAgeToExceed(
          metadataLocator,
          afterTab1ClientAge,
          0,
        );
        const finalText = await metadataLocator.textContent();
        const finalServerRendered = extractServerRendered(finalText);

        // Server Rendered should STILL be the same
        expect(finalServerRendered).toBe(initialServerRendered);

        // Client Age should have increased further
        expect(finalClientAge).toBeGreaterThan(afterTab1ClientAge);
      },
    );
  });
});

/**
 * Production build tests for revalidation - same tests as dev to verify no diff
 */
test.describe("revalidation-query-param-navigation (production)", () => {
  const f = useFixture({
    root: ".",
    mode: "build",
  });

  test.setTimeout(120000);

  test.describe("product-detail-page", () => {
    test("should keep timer running when navigating between query params (tab=details to tab=reviews)", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/shop/product/wireless-headphones?tab=details"));
      await waitForHydration(page);

      await expect(
        page.locator("h2:has-text('Wireless Headphones')"),
      ).toBeVisible({ timeout: 15000 });

      const metadataLocator = page.locator(
        "text=/Server Rendered:.*Client Age:/",
      );
      await expect(metadataLocator).toBeVisible({ timeout: 5000 });

      const initialText = await metadataLocator.textContent();
      const initialServerRendered = extractServerRendered(initialText);
      const initialClientAge = extractClientAge(initialText);

      await page.locator('a:has-text("Change to ?tab=reviews")').click();
      await expect(page).toHaveURL(/tab=reviews/);

      const newClientAge = await waitForClientAgeToExceed(
        metadataLocator,
        initialClientAge,
      );
      const newText = await metadataLocator.textContent();
      const newServerRendered = extractServerRendered(newText);

      expect(newServerRendered).toBe(initialServerRendered);
      expect(newClientAge).toBeGreaterThan(initialClientAge + 1);
    });

    test("should reset timer when slug changes (different product)", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/shop/product/wireless-headphones"));
      await waitForHydration(page);

      await expect(
        page.locator("h2:has-text('Wireless Headphones')"),
      ).toBeVisible({ timeout: 15000 });

      const metadataLocator = page.locator(
        "text=/Server Rendered:.*Client Age:/",
      );
      const beforeClientAge = await waitForClientAgeToExceed(
        metadataLocator,
        0,
        2,
        6000,
      );

      expect(beforeClientAge).toBeGreaterThanOrEqual(3);

      await page.locator('a:has-text("Running Shoes")').click();

      await expect(page.locator("h2:has-text('Running Shoes')")).toBeVisible({
        timeout: 15000,
      });

      const afterText = await metadataLocator.textContent();
      const afterClientAge = extractClientAge(afterText);

      expect(afterClientAge).toBeLessThan(beforeClientAge);
    });
  });

  test.describe("blog-post-page", () => {
    test("should keep timer running when navigating between query params (?tab=1 to ?tab=2)", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/blog/hello-world"));
      await waitForHydration(page);

      await expect(page.locator("text=Hello World").first()).toBeVisible({
        timeout: 5000,
      });

      const metadataLocator = page.locator(
        "text=/Server Rendered:.*Client Age:/",
      );
      await expect(metadataLocator).toBeVisible({ timeout: 5000 });

      const initialText = await metadataLocator.textContent();
      const initialServerRendered = extractServerRendered(initialText);
      const initialClientAge = extractClientAge(initialText);

      await page.locator('a:has-text("Add ?tab=1")').click();
      await expect(page).toHaveURL(/tab=1/);

      const afterTab1ClientAge = await waitForClientAgeToExceed(
        metadataLocator,
        initialClientAge,
      );
      const afterTab1Text = await metadataLocator.textContent();
      const afterTab1ServerRendered = extractServerRendered(afterTab1Text);

      expect(afterTab1ServerRendered).toBe(initialServerRendered);
      expect(afterTab1ClientAge).toBeGreaterThan(initialClientAge + 1);

      await page.locator('a:has-text("Change to ?tab=2")').click();
      await expect(page).toHaveURL(/tab=2/);

      const finalClientAge = await waitForClientAgeToExceed(
        metadataLocator,
        afterTab1ClientAge,
        0,
      );
      const finalText = await metadataLocator.textContent();
      const finalServerRendered = extractServerRendered(finalText);

      expect(finalServerRendered).toBe(initialServerRendered);
      expect(finalClientAge).toBeGreaterThan(afterTab1ClientAge);
    });
  });
});
