import { expect, test } from "@playwright/test";
import { test as devTest, devURL } from "./dev-fixture";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError } from "./helper";

/**
 * Cache scope + loader side-effect tests
 *
 * Loaders are always fresh (never cached), so response-level side effects
 * like setCookie() must be allowed even when the loader is inside a cache()
 * boundary. These tests verify that the cache scope guard does NOT
 * false-positive on loader execution.
 */

// ---------- DEV ----------
devTest.describe("cache-scope-loader-side-effects (dev)", () => {
  devTest(
    "document request to /shop succeeds (loader setCookie inside cache boundary)",
    async ({ page, devServerURL }) => {
      using _ = expectNoPageError(page);

      // /shop uses cache() + loader(CartLoader) where CartLoader
      // calls cookies().set() via getOrCreateCartId()
      const response = await page.goto(devURL(devServerURL, "/shop"));
      expect(response?.status()).toBe(200);

      await waitForHydration(page);
      await expect(page.locator("text=All Products")).toBeVisible();
    },
  );

  devTest(
    "client navigation to /shop succeeds",
    async ({ page, devServerURL }) => {
      using _ = expectNoPageError(page);

      // Start from home page
      await page.goto(devURL(devServerURL, "/"));
      await waitForHydration(page);

      // Navigate to shop via link
      await page.locator('a[href="/shop"]').first().click();
      await expect(page.locator("text=All Products")).toBeVisible({
        timeout: 10000,
      });
    },
  );

  devTest(
    "intercept modal with loader setCookie inside cache boundary succeeds",
    async ({ page, devServerURL }) => {
      using _ = expectNoPageError(page);

      // Load the shop page first
      await page.goto(devURL(devServerURL, "/shop"));
      await waitForHydration(page);
      await expect(page.locator("text=All Products")).toBeVisible();

      // Click a product to open the intercept modal — this triggers
      // ProductCartLoader via context.use(loader) in the intercept path
      await page
        .locator('a[href="/shop/product/wireless-headphones"]')
        .first()
        .click();
      await expect(page.locator("text=Intercepted")).toBeVisible({
        timeout: 10000,
      });
    },
  );
});

// ---------- PRODUCTION ----------
const prod = useFixture({ root: ".", mode: "build" });

test.describe("cache-scope-loader-side-effects (prod)", () => {
  test("document request to /shop succeeds (loader setCookie inside cache boundary)", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    const response = await page.goto(prod.url("/shop"));
    expect(response?.status()).toBe(200);

    await waitForHydration(page);
    await expect(page.locator("text=All Products")).toBeVisible();
  });

  test("client navigation to /shop succeeds", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(prod.url("/"));
    await waitForHydration(page);

    await page.locator('a[href="/shop"]').first().click();
    await expect(page.locator("text=All Products")).toBeVisible({
      timeout: 10000,
    });
  });

  test("intercept modal with loader setCookie inside cache boundary succeeds", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(prod.url("/shop"));
    await waitForHydration(page);
    await expect(page.locator("text=All Products")).toBeVisible();

    // Click a product to open the intercept modal
    await page
      .locator('a[href="/shop/product/wireless-headphones"]')
      .first()
      .click();
    await expect(page.locator("text=Intercepted")).toBeVisible({
      timeout: 10000,
    });
  });
});
