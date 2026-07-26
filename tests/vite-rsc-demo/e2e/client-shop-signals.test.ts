import { expect, test, type Page } from "@playwright/test";
import { test as devTest, devURL } from "./dev-fixture";
import { waitForHydration, prodDescribe } from "./helper";

/**
 * Loader-thrown authority signals on clientUrls routes (/client-shop).
 *
 * The product loader throws notFound() for unknown slugs and redirect() for
 * moved slugs. Contract pinned here:
 * - Document lane, missing product: the fast rejection wins the flush race so
 *   the response status is a REAL 404; after hydration the app-level 404 UI
 *   (router notFound option, server-rendered into the streamed envelope)
 *   replaces the mounted shop tree while the ROOT layout chrome persists; the
 *   URL is preserved.
 * - Document lane, moved product: 200 document, then a client replace to the
 *   target (document-lane redirect authority stays middleware-only).
 * - Navigation lane, missing product: 404 UI swaps in via the loader-signal
 *   marker with the URL preserved (no history entry to the broken state).
 * - Navigation lane, moved product: the redirect envelope navigates to the
 *   target product, which renders fully.
 */

async function expectMissingProduct404UI(page: Page) {
  await expect(page.locator('[data-testid="app-not-found"]')).toBeVisible({
    timeout: 8000,
  });
  await expect(
    page.locator('[data-testid="not-found-pathname"]'),
  ).toContainText("/client-shop/product/discontinued-widget");
  // Root layout chrome persists — the 404 replaces the mounted shop tree only.
  // (Probe the nav link, present in dev AND production builds; the "LAYOUT:
  // ROOT" banner is dev-only.)
  await expect(
    page.locator('a[href="/client-shop"]', { hasText: "Client Shop" }),
  ).toBeVisible();
}

/**
 * The real-404 STATUS is opportunistic: it lands only when the loader's
 * notFound() rejection beats construction of the document Response. A first
 * request that also pays cold work (dev module transform, cold worker) can lose
 * that race — the 404 UI still streams correctly either way, because it rides
 * the envelope, but the status stays 200. Asserting `toBe(404)` on an unwarmed
 * request therefore tests startup timing, not the contract; it flaked in the
 * full suite (received 200) while passing 3/3 in isolation.
 *
 * Warm the route first so the status assertion pins the contract we actually
 * mean: a warm document load of a missing product carries a real 404. The
 * warmup is cheap — notFound() throws before the loader's 2s cached fetch. The
 * UI and URL assertions are race-free and need no warmup.
 */
async function warmDocumentRoute(page: Page, url: string): Promise<void> {
  await page.request.get(url);
}

devTest.describe("client-shop loader signals", () => {
  devTest(
    "document load of a missing product responds 404 and shows the 404 UI",
    async ({ page, devServerURL }) => {
      const url = devURL(
        devServerURL,
        "/client-shop/product/discontinued-widget",
      );
      await warmDocumentRoute(page, url);
      const response = await page.goto(url);
      expect(response!.status()).toBe(404);
      await waitForHydration(page);
      await expectMissingProduct404UI(page);
      expect(page.url()).toContain("/client-shop/product/discontinued-widget");
    },
  );

  devTest(
    "document load of a moved product redirects client-side to the new slug",
    async ({ page, devServerURL }) => {
      await page.goto(devURL(devServerURL, "/client-shop/product/headphones"));
      await page.waitForURL("**/client-shop/product/wireless-headphones", {
        timeout: 10000,
      });
      await expect(
        page.locator('[data-testid="client-shop-name"]'),
      ).toContainText("Wireless Headphones", { timeout: 10000 });
    },
  );

  devTest(
    "navigating to a missing product swaps in the 404 UI with the URL preserved",
    async ({ page, devServerURL }) => {
      await page.goto(devURL(devServerURL, "/client-shop"));
      await waitForHydration(page);
      await page.click('[data-testid="client-shop-missing-link"]');
      await expectMissingProduct404UI(page);
      expect(page.url()).toContain("/client-shop/product/discontinued-widget");
    },
  );

  devTest(
    "navigating to a moved product redirects to the target product",
    async ({ page, devServerURL }) => {
      await page.goto(devURL(devServerURL, "/client-shop"));
      await waitForHydration(page);
      await page.click('[data-testid="client-shop-legacy-link"]');
      await page.waitForURL("**/client-shop/product/wireless-headphones", {
        timeout: 10000,
      });
      await expect(
        page.locator('[data-testid="client-shop-name"]'),
      ).toContainText("Wireless Headphones", { timeout: 10000 });
    },
  );
});

prodDescribe("client-shop loader signals", (f) => {
  test("document load of a missing product responds 404 and shows the 404 UI", async ({
    page,
  }) => {
    const url = f.url("/client-shop/product/discontinued-widget");
    // Same opportunistic-status race as the dev twin (see warmDocumentRoute):
    // no module transform here, but a cold worker on the first request can still
    // lose it. Warmed for the same reason, so both lanes pin the same contract.
    await warmDocumentRoute(page, url);
    const response = await page.goto(url);
    expect(response!.status()).toBe(404);
    await waitForHydration(page);
    await expectMissingProduct404UI(page);
    expect(page.url()).toContain("/client-shop/product/discontinued-widget");
  });

  test("document load of a moved product redirects client-side to the new slug", async ({
    page,
  }) => {
    await page.goto(f.url("/client-shop/product/headphones"));
    await page.waitForURL("**/client-shop/product/wireless-headphones", {
      timeout: 10000,
    });
    await expect(
      page.locator('[data-testid="client-shop-name"]'),
    ).toContainText("Wireless Headphones", { timeout: 10000 });
  });

  test("navigating to a missing product swaps in the 404 UI with the URL preserved", async ({
    page,
  }) => {
    await page.goto(f.url("/client-shop"));
    await waitForHydration(page);
    await page.click('[data-testid="client-shop-missing-link"]');
    await expectMissingProduct404UI(page);
    expect(page.url()).toContain("/client-shop/product/discontinued-widget");
  });

  test("navigating to a moved product redirects to the target product", async ({
    page,
  }) => {
    await page.goto(f.url("/client-shop"));
    await waitForHydration(page);
    await page.click('[data-testid="client-shop-legacy-link"]');
    await page.waitForURL("**/client-shop/product/wireless-headphones", {
      timeout: 10000,
    });
    await expect(
      page.locator('[data-testid="client-shop-name"]'),
    ).toContainText("Wireless Headphones", { timeout: 10000 });
  });
});
