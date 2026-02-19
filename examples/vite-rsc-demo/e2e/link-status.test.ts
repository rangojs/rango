import { test, expect, devURL } from "./dev-fixture";
import {
  waitForHydration,
  expectNoPageError,
  testId,
} from "./helper";

/**
 * useLinkStatus tests - verifies pending indicator shows during navigation
 * and disappears once content loads.
 * Source: packages/rangojs-router/src/browser/react/use-link-status.ts
 */
test.describe("link-status", () => {
  test("should show pending indicator during navigation to blog", async ({
    page,
    devServerURL,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(devURL(devServerURL, "/"));
    await waitForHydration(page);

    // Pending indicator should not be visible before navigation
    await expect(testId(page, "link-pending")).not.toBeVisible();

    // Inject a MutationObserver to detect the transient pending indicator.
    // The pending state may flash very briefly (< 100ms) if the initial RSC
    // response arrives fast, so we need to observe DOM mutations.
    await page.evaluate(() => {
      (window as any).__pendingDetected = false;
      const observer = new MutationObserver(() => {
        const el = document.querySelector('[data-testid="link-pending"]');
        if (el) {
          (window as any).__pendingDetected = true;
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });
      (window as any).__pendingObserver = observer;
    });

    // Click the Blog nav link (which has LinkStatusIndicator as a child)
    const blogLink = page.locator('nav a:has-text("Blog")');
    await blogLink.click();

    // Wait for blog content to fully load
    await expect(page.locator("text=Blog Posts")).toBeVisible({
      timeout: 10000,
    });

    // Check that the pending indicator was detected during the transition
    const pendingDetected = await page.evaluate(
      () => (window as any).__pendingDetected
    );
    expect(pendingDetected).toBe(true);

    // After navigation completes, the pending indicator should be gone
    await expect(testId(page, "link-pending")).not.toBeVisible();

    // Clean up the observer
    await page.evaluate(() => {
      (window as any).__pendingObserver?.disconnect();
    });
  });

  test("should not show pending indicator when navigating to other links", async ({
    page,
    devServerURL,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(devURL(devServerURL, "/"));
    await waitForHydration(page);

    // Set up the same observer
    await page.evaluate(() => {
      (window as any).__pendingDetected = false;
      const observer = new MutationObserver(() => {
        const el = document.querySelector('[data-testid="link-pending"]');
        if (el) {
          (window as any).__pendingDetected = true;
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });
      (window as any).__pendingObserver = observer;
    });

    // Click the Shop nav link (which does NOT have LinkStatusIndicator)
    const shopLink = page.locator('nav a:has-text("Shop")');
    await shopLink.click();

    // Shop content should load
    await expect(page.locator("text=Featured Products")).toBeVisible({
      timeout: 10000,
    });

    // The Blog link's pending indicator should NOT have appeared
    const pendingDetected = await page.evaluate(
      () => (window as any).__pendingDetected
    );
    expect(pendingDetected).toBe(false);

    // Clean up
    await page.evaluate(() => {
      (window as any).__pendingObserver?.disconnect();
    });
  });
});
