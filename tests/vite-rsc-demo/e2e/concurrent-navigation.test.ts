import { expect, test } from "@playwright/test";
import { test as devTest, devURL } from "./dev-fixture";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError } from "./helper";

/**
 * Concurrent navigation cancellation tests - verifies switchMap semantics
 * where rapid navigations abort previous ones and only the final destination loads.
 * Source: packages/rangojs-router/src/browser/event-controller.ts (switchMap in startNavigation)
 *         packages/rangojs-router/src/browser/navigation-bridge.ts (abortNavigation)
 */
devTest.describe("concurrent-navigation", () => {
  devTest(
    "should cancel intermediate navigations on rapid link clicks",
    async ({ page, devServerURL }) => {
      using _ = expectNoPageError(page);

      // Use the nav bar links which are always visible regardless of page content.
      // Navigate to home first.
      await page.goto(devURL(devServerURL, "/"));
      await waitForHydration(page);

      // Rapidly click multiple nav links without waiting for navigation to complete.
      // The switchMap semantics should abort intermediate navigations.
      await page.locator('nav a:has-text("About")').click();
      await page.locator('nav a:has-text("Blog")').click();
      await page.locator('nav a:text-is("Shop")').click();

      // The final destination (Shop) should win
      await expect(page).toHaveURL(/\/shop/, { timeout: 10000 });

      // Shop content should be visible
      await expect(page.locator("text=Featured Products")).toBeVisible({
        timeout: 10000,
      });

      // No page errors should have leaked (AbortErrors should be caught internally)
    },
  );

  devTest(
    "should handle back navigation during pending forward navigation",
    async ({ page, devServerURL }) => {
      using _ = expectNoPageError(page);

      // Build up a history stack: / -> /about
      await page.goto(devURL(devServerURL, "/"));
      await waitForHydration(page);

      await page.locator('nav a:has-text("About")').click();
      await expect(page.locator("h1:has-text('About')")).toBeVisible({
        timeout: 5000,
      });

      // Now click Blog to start a navigation, then immediately go back.
      // This tests that the router gracefully handles popstate during
      // a pending forward navigation.
      await page.locator('nav a:has-text("Blog")').click();
      await page.goBack();

      // Wait for things to settle
      await page.waitForTimeout(3000);

      // The page should be in a valid, error-free state. The exact URL
      // depends on whether the Blog navigation was committed before
      // the popstate fired. Either outcome is acceptable as long as
      // there are no errors.
      const bodyText = await page.locator("body").textContent();
      expect(bodyText).toBeTruthy();
    },
  );

  devTest(
    "should settle to correct page after interleaved forward navigations",
    async ({ page, devServerURL }) => {
      using _ = expectNoPageError(page);

      await page.goto(devURL(devServerURL, "/"));
      await waitForHydration(page);

      // Start navigating to blog, then immediately redirect to shop
      await page.locator('nav a:has-text("Blog")').click();

      // While blog navigation is in flight, click shop
      await page.locator('nav a:text-is("Shop")').click();

      // The final destination should win
      await expect(page).toHaveURL(/\/shop/, { timeout: 10000 });

      // Shop content should be visible
      await expect(page.locator("text=Featured Products")).toBeVisible({
        timeout: 10000,
      });
    },
  );
});

// ---------- PRODUCTION ----------
test.describe("concurrent-navigation (production)", () => {
  const f = useFixture({ root: ".", mode: "build" });

  test("should cancel intermediate navigations on rapid link clicks", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // Use the nav bar links which are always visible regardless of page content.
    // Navigate to home first.
    await page.goto(f.url("/"));
    await waitForHydration(page);

    // Rapidly click multiple nav links without waiting for navigation to complete.
    // The switchMap semantics should abort intermediate navigations.
    await page.locator('nav a:has-text("About")').click();
    await page.locator('nav a:has-text("Blog")').click();
    await page.locator('nav a:text-is("Shop")').click();

    // The final destination (Shop) should win
    await expect(page).toHaveURL(/\/shop/, { timeout: 10000 });

    // Shop content should be visible
    await expect(page.locator("text=Featured Products")).toBeVisible({
      timeout: 10000,
    });

    // No page errors should have leaked (AbortErrors should be caught internally)
  });

  test("should handle back navigation during pending forward navigation", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // Build up a history stack: / -> /about
    await page.goto(f.url("/"));
    await waitForHydration(page);

    await page.locator('nav a:has-text("About")').click();
    await expect(page.locator("h1:has-text('About')")).toBeVisible({
      timeout: 5000,
    });

    // Now click Blog to start a navigation, then immediately go back.
    // This tests that the router gracefully handles popstate during
    // a pending forward navigation.
    await page.locator('nav a:has-text("Blog")').click();
    await page.goBack();

    // Wait for things to settle
    await page.waitForTimeout(3000);

    // The page should be in a valid, error-free state. The exact URL
    // depends on whether the Blog navigation was committed before
    // the popstate fired. Either outcome is acceptable as long as
    // there are no errors.
    const bodyText = await page.locator("body").textContent();
    expect(bodyText).toBeTruthy();
  });

  test("should settle to correct page after interleaved forward navigations", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/"));
    await waitForHydration(page);

    // Start navigating to blog, then immediately redirect to shop
    await page.locator('nav a:has-text("Blog")').click();

    // While blog navigation is in flight, click shop
    await page.locator('nav a:text-is("Shop")').click();

    // The final destination should win
    await expect(page).toHaveURL(/\/shop/, { timeout: 10000 });

    // Shop content should be visible
    await expect(page.locator("text=Featured Products")).toBeVisible({
      timeout: 10000,
    });
  });
});
