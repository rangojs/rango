import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import {
  waitForHydration,
  expectNoPageError,
  goBack,
} from "./helper";

/**
 * Scroll restoration tests - verifies scroll position persistence across navigations.
 * Source: packages/rangojs-router/src/browser/scroll-restoration.ts
 */
test.describe("scroll-restoration", () => {
  const f = useFixture({
    root: ".",
    mode: "dev",
  });

  test("should scroll to top on forward navigation", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/blog"));
    await waitForHydration(page);

    // Wait for sidebar to load so the page has full content height
    await expect(page.locator("text=Recent Posts")).toBeVisible({
      timeout: 8000,
    });

    // Scroll down to create a non-zero scroll position
    await page.evaluate(() => window.scrollTo(0, 300));
    await page.waitForTimeout(100);

    const scrollBefore = await page.evaluate(() => window.scrollY);
    expect(scrollBefore).toBeGreaterThan(0);

    // Click a blog post link to navigate forward
    await page.locator('a[href="/blog/hello-world"]').first().click();

    // Wait for post content to load
    await expect(page.locator("h2:has-text('Hello World')")).toBeVisible({
      timeout: 5000,
    });

    // Scroll should be reset to top on forward navigation
    const scrollAfter = await page.evaluate(() => window.scrollY);
    expect(scrollAfter).toBe(0);
  });

  test("should restore scroll position on back navigation", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/blog"));
    await waitForHydration(page);

    // Wait for sidebar so the page is fully rendered and scrollable
    await expect(page.locator("text=Recent Posts")).toBeVisible({
      timeout: 8000,
    });

    // Scroll to a specific position
    const targetScroll = 200;
    await page.evaluate((y) => window.scrollTo(0, y), targetScroll);
    await page.waitForTimeout(100);

    const scrollBefore = await page.evaluate(() => window.scrollY);
    expect(scrollBefore).toBeGreaterThan(0);

    // Navigate forward to a blog post
    await page.locator('a[href="/blog/hello-world"]').first().click();
    await expect(page.locator("h2:has-text('Hello World')")).toBeVisible({
      timeout: 5000,
    });

    // Navigate back
    await goBack(page);

    // Blog index should be restored
    await expect(page.locator("text=Blog Posts")).toBeVisible();

    // Wait for scroll restoration (may poll during streaming)
    await expect
      .poll(() => page.evaluate(() => window.scrollY), { timeout: 5000 })
      .toBeGreaterThan(0);

    // Scroll should be restored within a tolerance (±50px accounts for
    // layout shifts during streaming and polling granularity)
    const scrollAfter = await page.evaluate(() => window.scrollY);
    expect(Math.abs(scrollAfter - scrollBefore)).toBeLessThan(50);
  });

  test("should handle scroll restoration across multiple navigations", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/blog"));
    await waitForHydration(page);

    await expect(page.locator("text=Recent Posts")).toBeVisible({
      timeout: 8000,
    });

    // Scroll to a known position on blog index
    await page.evaluate(() => window.scrollTo(0, 150));
    await page.waitForTimeout(100);

    // Navigate to first post
    await page.locator('a[href="/blog/hello-world"]').first().click();
    await expect(page.locator("h2:has-text('Hello World')")).toBeVisible({
      timeout: 5000,
    });

    // Navigate to a second post via sidebar
    await page.locator('a[href="/blog/rsc-routing"]').click();
    await expect(page.locator("h2:has-text('Rsc Routing')")).toBeVisible({
      timeout: 5000,
    });

    // Go back to first post
    await goBack(page);
    await expect(page.locator("h2:has-text('Hello World')")).toBeVisible({
      timeout: 5000,
    });

    // Go back to blog index
    await goBack(page);
    await expect(page.locator("text=Blog Posts")).toBeVisible({
      timeout: 5000,
    });

    // Scroll position should be restored to the original position
    await expect
      .poll(() => page.evaluate(() => window.scrollY), { timeout: 5000 })
      .toBeGreaterThan(0);
  });
});
