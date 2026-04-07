import { test, expect, devURL } from "./dev-fixture";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError, testId, goBack } from "./helper";

/**
 * Helper: inject a MutationObserver that detects any appearance of [data-testid="link-pending"].
 * Pending state may flash very briefly (<100ms), so polling alone can miss it.
 */
async function observePending(page: import("@playwright/test").Page) {
  await page.evaluate(() => {
    (window as any).__pendingDetected = false;
    (window as any).__pendingCount = 0;
    const observer = new MutationObserver(() => {
      const el = document.querySelector('[data-testid="link-pending"]');
      if (el) {
        (window as any).__pendingDetected = true;
        (window as any).__pendingCount++;
      }
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
    });
    (window as any).__pendingObserver = observer;
  });
}

async function getPendingDetected(
  page: import("@playwright/test").Page,
): Promise<boolean> {
  return page.evaluate(() => (window as any).__pendingDetected);
}

async function resetPendingDetected(
  page: import("@playwright/test").Page,
): Promise<void> {
  await page.evaluate(() => {
    (window as any).__pendingDetected = false;
    (window as any).__pendingCount = 0;
  });
}

async function cleanupObserver(
  page: import("@playwright/test").Page,
): Promise<void> {
  await page.evaluate(() => {
    (window as any).__pendingObserver?.disconnect();
  });
}

// =============================================================================
// Dev mode
// =============================================================================

test.describe("pending-links", () => {
  test("should show pending indicator when navigating to blog", async ({
    page,
    devServerURL,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(devURL(devServerURL, "/"));
    await waitForHydration(page);
    await expect(testId(page, "link-pending")).not.toBeVisible();

    await observePending(page);

    await page.locator('nav a:has-text("Blog")').click();
    await expect(page.locator("text=Blog Posts")).toBeVisible({
      timeout: 10000,
    });

    expect(await getPendingDetected(page)).toBe(true);
    await expect(testId(page, "link-pending")).not.toBeVisible();
    await cleanupObserver(page);
  });

  test("should NOT show pending indicator for links without useLinkStatus", async ({
    page,
    devServerURL,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(devURL(devServerURL, "/"));
    await waitForHydration(page);

    await observePending(page);

    // Dashboard link does NOT have LinkStatusIndicator
    await page.locator('nav a:has-text("Dashboard")').click();
    await expect(
      page.getByRole("heading", { name: "Dashboard Home" }),
    ).toBeVisible({
      timeout: 10000,
    });

    expect(await getPendingDetected(page)).toBe(false);
    await cleanupObserver(page);
  });

  test("should reset pending state after navigation completes", async ({
    page,
    devServerURL,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(devURL(devServerURL, "/"));
    await waitForHydration(page);

    // Navigate to blog (triggers pending)
    await page.locator('nav a:has-text("Blog")').click();
    await expect(page.locator("text=Blog Posts")).toBeVisible({
      timeout: 10000,
    });

    // Pending should be gone after nav completes
    await expect(testId(page, "link-pending")).not.toBeVisible();

    // Navigate back
    await goBack(page);
    await expect(page).toHaveURL(/\/$/);

    // Pending should still be gone
    await expect(testId(page, "link-pending")).not.toBeVisible();
  });

  test("should show pending on navigation to different routes", async ({
    page,
    devServerURL,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(devURL(devServerURL, "/"));
    await waitForHydration(page);

    // First navigation to blog
    await observePending(page);
    await page.locator('nav a:has-text("Blog")').click();
    await expect(page.locator("text=Blog Posts")).toBeVisible({
      timeout: 10000,
    });
    expect(await getPendingDetected(page)).toBe(true);
    await expect(testId(page, "link-pending")).not.toBeVisible();

    // Navigate to a different route (shop) — blog link pending should NOT fire
    await resetPendingDetected(page);
    await page.locator('nav a:has-text("Shop")').click();
    await expect(page.locator("text=Featured Products")).toBeVisible({
      timeout: 10000,
    });
    expect(await getPendingDetected(page)).toBe(false);

    // Navigate back to blog from shop — pending should fire again
    await resetPendingDetected(page);
    await page.locator('nav a:has-text("Blog")').click();
    await expect(page.locator("text=Blog Posts")).toBeVisible({
      timeout: 10000,
    });
    // Pending may or may not fire (cached response), so just verify it resets
    await expect(testId(page, "link-pending")).not.toBeVisible();

    await cleanupObserver(page);
  });

  test("should show pending indicator for blog link even when clicking from a sub-page", async ({
    page,
    devServerURL,
  }) => {
    using _ = expectNoPageError(page);

    // Start on a non-home page
    await page.goto(devURL(devServerURL, "/shop"));
    await waitForHydration(page);

    await observePending(page);

    // Click blog from shop page
    await page.locator('nav a:has-text("Blog")').click();
    await expect(page.locator("text=Blog Posts")).toBeVisible({
      timeout: 10000,
    });

    expect(await getPendingDetected(page)).toBe(true);
    await expect(testId(page, "link-pending")).not.toBeVisible();
    await cleanupObserver(page);
  });
});

// =============================================================================
// Production build
// =============================================================================

test.describe("pending-links (production)", () => {
  const f = useFixture({
    root: ".",
    mode: "build",
  });

  test.setTimeout(120000);

  test("should show pending indicator when navigating to blog", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/"));
    await waitForHydration(page);
    await expect(testId(page, "link-pending")).not.toBeVisible();

    await observePending(page);

    await page.locator('nav a:has-text("Blog")').click();
    await expect(page.locator("text=Blog Posts")).toBeVisible({
      timeout: 10000,
    });

    expect(await getPendingDetected(page)).toBe(true);
    await expect(testId(page, "link-pending")).not.toBeVisible();
    await cleanupObserver(page);
  });

  test("should NOT show pending indicator for links without useLinkStatus", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/"));
    await waitForHydration(page);

    await observePending(page);

    await page.locator('nav a:has-text("Dashboard")').click();
    await expect(
      page.getByRole("heading", { name: "Dashboard Home" }),
    ).toBeVisible({
      timeout: 10000,
    });

    expect(await getPendingDetected(page)).toBe(false);
    await cleanupObserver(page);
  });

  test("should reset pending state after navigation completes", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/"));
    await waitForHydration(page);

    await page.locator('nav a:has-text("Blog")').click();
    await expect(page.locator("text=Blog Posts")).toBeVisible({
      timeout: 10000,
    });

    await expect(testId(page, "link-pending")).not.toBeVisible();

    await goBack(page);
    await expect(page).toHaveURL(/\/$/);
    await expect(testId(page, "link-pending")).not.toBeVisible();
  });

  test("should show pending on navigation to different routes", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/"));
    await waitForHydration(page);

    await observePending(page);

    // First nav to blog
    await page.locator('nav a:has-text("Blog")').click();
    await expect(page.locator("text=Blog Posts")).toBeVisible({
      timeout: 10000,
    });
    expect(await getPendingDetected(page)).toBe(true);
    await expect(testId(page, "link-pending")).not.toBeVisible();

    // Navigate to shop — blog pending should NOT fire
    await resetPendingDetected(page);
    await page.locator('nav a:has-text("Shop")').click();
    await expect(page.locator("text=Featured Products")).toBeVisible({
      timeout: 10000,
    });
    expect(await getPendingDetected(page)).toBe(false);

    // Navigate back to blog — pending may or may not fire (cached)
    await resetPendingDetected(page);
    await page.locator('nav a:has-text("Blog")').click();
    await expect(page.locator("text=Blog Posts")).toBeVisible({
      timeout: 10000,
    });
    await expect(testId(page, "link-pending")).not.toBeVisible();

    await cleanupObserver(page);
  });
});
