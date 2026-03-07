import { expect, test } from "@playwright/test";
import { test as devTest, devURL } from "./dev-fixture";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError, goBack } from "./helper";

/**
 * Shop breadcrumb tests - handle data caching through intercept navigation
 */
devTest.describe("shop-breadcrumbs", () => {
  devTest(
    "should preserve category breadcrumbs after navigating to product detail and back (no intercept from category)",
    async ({ page, devServerURL }) => {
      using _ = expectNoPageError(page);

      // Capture console logs for debugging
      const logs: string[] = [];
      page.on("console", (msg) => {
        if (
          msg.text().includes("[Browser]") ||
          msg.text().includes("[NavigationProvider]") ||
          msg.text().includes("[Store]")
        ) {
          logs.push(msg.text());
        }
      });

      const breadcrumbNav = page.locator('nav[aria-label="Breadcrumb"]');

      // Step 1: Navigate to shop page
      await page.goto(devURL(devServerURL, "/shop"));
      await waitForHydration(page);

      // Verify shop breadcrumb
      await expect(breadcrumbNav.locator("text=Shop")).toBeVisible();

      // Step 2: Navigate to a category page (sidebar only shown on index)
      await page
        .locator('a[href="/shop/products/electronics"]')
        .first()
        .click();
      await expect(page.locator("h2:has-text('Electronics')")).toBeVisible({
        timeout: 5000,
      });

      // Verify category breadcrumbs: Shop > Electronics
      await expect(breadcrumbNav.locator("text=Shop")).toBeVisible();
      await expect(breadcrumbNav.locator("text=Electronics")).toBeVisible();

      // Step 3: Click on a product - should go directly to full product page (no intercept from category)
      // Note: when() condition only allows intercept from shop index, not from category pages
      await page
        .locator('a[href="/shop/product/wireless-headphones"]')
        .first()
        .click();
      await expect(page.locator("text=Intercepted")).not.toBeVisible({
        timeout: 5000,
      });
      await expect(page.locator("text=Test Revalidation Behavior")).toBeVisible(
        { timeout: 5000 },
      );

      // Step 4: Go back - should return to category page
      await goBack(page);
      await expect(page.locator("text=Intercepted")).not.toBeVisible({
        timeout: 5000,
      });

      // CRITICAL: Category breadcrumbs should be restored: Shop > Electronics
      await expect(breadcrumbNav.locator("text=Shop")).toBeVisible();

      // Print debug logs only when requested.
      if (process.env.TEST_DEBUG) {
        console.log("=== Browser Console Logs ===");
        logs.forEach((log) => console.log(log));
        console.log("=== End Browser Console Logs ===");
      }

      await expect(breadcrumbNav.locator("text=Electronics")).toBeVisible({
        timeout: 5000,
      });
    },
  );

  devTest(
    "should display correct breadcrumbs on shop index",
    async ({ page, devServerURL }) => {
      using _ = expectNoPageError(page);

      await page.goto(devURL(devServerURL, "/shop"));
      await waitForHydration(page);

      const breadcrumbNav = page.locator('nav[aria-label="Breadcrumb"]');
      await expect(breadcrumbNav.locator("text=Shop")).toBeVisible();
    },
  );

  devTest(
    "should display category breadcrumbs",
    async ({ page, devServerURL }) => {
      using _ = expectNoPageError(page);

      await page.goto(devURL(devServerURL, "/shop/products/electronics"));
      await waitForHydration(page);

      const breadcrumbNav = page.locator('nav[aria-label="Breadcrumb"]');
      await expect(breadcrumbNav.locator("text=Shop")).toBeVisible();
      await expect(breadcrumbNav.locator("text=Electronics")).toBeVisible();
    },
  );

  devTest(
    "should display product breadcrumbs on direct navigation",
    async ({ page, devServerURL }) => {
      using _ = expectNoPageError(page);

      await page.goto(
        devURL(devServerURL, "/shop/product/wireless-headphones"),
      );
      await waitForHydration(page);

      // Wait for product to load
      await expect(
        page.locator("h2:has-text('Wireless Headphones')"),
      ).toBeVisible({ timeout: 10000 });

      const breadcrumbNav = page.locator('nav[aria-label="Breadcrumb"]');
      await expect(breadcrumbNav.locator("text=Shop")).toBeVisible();
      await expect(
        breadcrumbNav.locator("text=Wireless Headphones"),
      ).toBeVisible();
    },
  );

  devTest(
    "should update breadcrumbs when navigating from shop to product detail",
    async ({ page, devServerURL }) => {
      using _ = expectNoPageError(page);

      await page.goto(devURL(devServerURL, "/shop"));
      await waitForHydration(page);

      const breadcrumbNav = page.locator('nav[aria-label="Breadcrumb"]');

      // Initially only Shop breadcrumb
      await expect(breadcrumbNav.locator("text=Shop")).toBeVisible();

      // Navigate to product via intercept
      await page
        .locator('a[href="/shop/product/wireless-headphones"]')
        .first()
        .click();
      await expect(page.locator("text=Intercepted")).toBeVisible({
        timeout: 10000,
      });

      // Go to full product page
      await page.locator("text=View Full Details").click();
      await expect(page.locator("text=Intercepted")).not.toBeVisible({
        timeout: 5000,
      });

      // Wait for product page to load
      await expect(
        page.locator("h2:has-text('Wireless Headphones')"),
      ).toBeVisible({ timeout: 10000 });

      // Breadcrumbs should show Shop > Product
      await expect(breadcrumbNav.locator("text=Shop")).toBeVisible();
      await expect(
        breadcrumbNav.locator("text=Wireless Headphones"),
      ).toBeVisible();
    },
  );

  devTest(
    "should restore breadcrumbs on simple back navigation from product to shop",
    async ({ page, devServerURL }) => {
      using _ = expectNoPageError(page);

      await page.goto(devURL(devServerURL, "/shop"));
      await waitForHydration(page);

      const breadcrumbNav = page.locator('nav[aria-label="Breadcrumb"]');

      // Navigate to product via intercept
      await page
        .locator('a[href="/shop/product/wireless-headphones"]')
        .first()
        .click();
      await expect(page.locator("text=Intercepted")).toBeVisible({
        timeout: 5000,
      });

      // Go back to shop
      await goBack(page);
      await expect(page.locator("text=Intercepted")).not.toBeVisible({
        timeout: 5000,
      });

      // Shop breadcrumb should be restored, no product breadcrumb
      await expect(breadcrumbNav.locator("text=Shop")).toBeVisible();
      await expect(
        breadcrumbNav.locator("text=Wireless Headphones"),
      ).not.toBeVisible();
    },
  );
});

/**
 * Production build tests for shop breadcrumbs
 */
test.describe("shop-breadcrumbs (production)", () => {
  const f = useFixture({
    root: ".",
    mode: "build",
  });

  test.setTimeout(120000);

  test("should display correct breadcrumbs on shop index", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/shop"));
    await waitForHydration(page);

    const breadcrumbNav = page.locator('nav[aria-label="Breadcrumb"]');
    await expect(breadcrumbNav.locator("text=Shop")).toBeVisible({
      timeout: 5000,
    });
  });

  test("should display category breadcrumbs", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/shop/products/electronics"));
    await waitForHydration(page);

    const breadcrumbNav = page.locator('nav[aria-label="Breadcrumb"]');
    await expect(breadcrumbNav.locator("text=Shop")).toBeVisible({
      timeout: 5000,
    });
    await expect(breadcrumbNav.locator("text=Electronics")).toBeVisible({
      timeout: 5000,
    });
  });

  test("should display product breadcrumbs on direct navigation", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/shop/product/wireless-headphones"));
    await waitForHydration(page);

    // Product detail has 1s artificial delay + loading time
    await expect(
      page.locator("h2:has-text('Wireless Headphones')"),
    ).toBeVisible({ timeout: 15000 });

    const breadcrumbNav = page.locator('nav[aria-label="Breadcrumb"]');
    await expect(breadcrumbNav.locator("text=Shop")).toBeVisible({
      timeout: 5000,
    });
    await expect(breadcrumbNav.locator("text=Wireless Headphones")).toBeVisible(
      { timeout: 5000 },
    );
  });
});
