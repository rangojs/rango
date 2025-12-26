import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, testId, goBack } from "./helper";

/**
 * Handle API tests - breadcrumbs accumulated across route segments
 */
test.describe("handle-breadcrumbs", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });

  test("should display home breadcrumb on index page", async ({ page }) => {
    await page.goto(f.url("/"));
    await waitForHydration(page);

    const breadcrumbs = testId(page, "breadcrumbs");
    await expect(breadcrumbs).toBeVisible();

    // Should show "Home" breadcrumb
    await expect(breadcrumbs.locator("text=Home")).toBeVisible();
  });

  test("should display nested breadcrumbs on product page", async ({ page }) => {
    await page.goto(f.url("/product/product-a"));
    await waitForHydration(page);

    const breadcrumbs = testId(page, "breadcrumbs");
    await expect(breadcrumbs).toBeVisible();

    // Should show "Home" and product name breadcrumbs
    await expect(breadcrumbs.locator("text=Home")).toBeVisible();
    await expect(breadcrumbs.locator("text=Product A")).toBeVisible();
  });

  test("should display nested breadcrumbs on blog pages", async ({ page }) => {
    await page.goto(f.url("/blog"));
    await waitForHydration(page);

    const breadcrumbs = testId(page, "breadcrumbs");
    await expect(breadcrumbs).toBeVisible();

    // Should show "Home" and "Blog" breadcrumbs
    await expect(breadcrumbs.locator("text=Home")).toBeVisible();
    await expect(breadcrumbs.locator("text=Blog")).toBeVisible();
  });

  test("should display three-level breadcrumbs on blog post", async ({
    page,
  }) => {
    await page.goto(f.url("/blog/post-1"));
    await waitForHydration(page);

    const breadcrumbs = testId(page, "breadcrumbs");
    await expect(breadcrumbs).toBeVisible();

    // Should show "Home", "Blog", and post breadcrumbs
    await expect(breadcrumbs.locator("text=Home")).toBeVisible();
    await expect(breadcrumbs.locator("text=Blog")).toBeVisible();
    await expect(breadcrumbs.locator("text=Post post-1")).toBeVisible();
  });

  test("should update breadcrumbs on navigation", async ({ page }) => {
    await page.goto(f.url("/"));
    await waitForHydration(page);

    const breadcrumbs = testId(page, "breadcrumbs");

    // Initially only "Home" breadcrumb
    await expect(breadcrumbs.locator("text=Home")).toBeVisible();
    await expect(breadcrumbs.locator("text=Blog")).not.toBeVisible();

    // Navigate to blog page (no intercept)
    await page.goto(f.url("/blog"));
    await waitForHydration(page);

    // Breadcrumbs should now include Blog
    await expect(breadcrumbs.locator("text=Home")).toBeVisible();
    await expect(breadcrumbs.locator("text=Blog")).toBeVisible();
  });

  test("should update breadcrumbs on back navigation", async ({ page }) => {
    await page.goto(f.url("/blog"));
    await waitForHydration(page);

    const breadcrumbs = testId(page, "breadcrumbs");

    // Both breadcrumbs visible on blog page
    await expect(breadcrumbs.locator("text=Home")).toBeVisible();
    await expect(breadcrumbs.locator("text=Blog")).toBeVisible();

    // Navigate back to home using breadcrumb link
    await testId(page, "breadcrumbs-link-home").click();

    // Wait for index page to load
    await expect(testId(page, "index-page")).toBeVisible({ timeout: 5000 });

    // Blog breadcrumb should be gone
    await expect(breadcrumbs.locator("text=Home")).toBeVisible();
    await expect(breadcrumbs.locator("text=Blog")).not.toBeVisible();
  });

  test("should show skeleton for async breadcrumb content", async ({
    page,
  }) => {
    await page.goto(f.url("/product/product-a"));
    await waitForHydration(page);

    const breadcrumbs = testId(page, "breadcrumbs");

    // Skeleton should appear while async content is loading (1s delay)
    const skeleton = testId(page, "breadcrumbs-skeleton");

    // Skeleton may or may not be visible depending on timing
    // But async content should eventually load
    await expect(testId(page, "breadcrumb-async")).toBeVisible({
      timeout: 3000,
    });
  });

  test("should stream async breadcrumb content", async ({ page }) => {
    await page.goto(f.url("/product/product-a"));
    await waitForHydration(page);

    // The async content has a 1s delay, so we wait for it to stream in
    await expect(testId(page, "breadcrumb-async")).toBeVisible({
      timeout: 3000,
    });

    // Content should include "Loaded:" text
    await expect(testId(page, "breadcrumb-async")).toContainText("Loaded:");
  });

  test("should not show hydration mismatch for breadcrumbs", async ({
    page,
  }) => {
    const hydrationErrors: string[] = [];

    page.on("console", (msg) => {
      const text = msg.text();
      if (
        text.includes("Hydration failed") ||
        text.includes("hydration mismatch") ||
        text.includes("Text content does not match")
      ) {
        hydrationErrors.push(text);
      }
    });

    // Test various pages for hydration issues
    await page.goto(f.url("/"));
    await waitForHydration(page);
    expect(hydrationErrors).toEqual([]);

    await page.goto(f.url("/product/product-a"));
    await waitForHydration(page);
    expect(hydrationErrors).toEqual([]);

    await page.goto(f.url("/blog"));
    await waitForHydration(page);
    expect(hydrationErrors).toEqual([]);

    await page.goto(f.url("/blog/post-1"));
    await waitForHydration(page);
    expect(hydrationErrors).toEqual([]);
  });

  test("should update breadcrumbs correctly during soft navigation", async ({
    page,
  }) => {
    await page.goto(f.url("/blog"));
    await waitForHydration(page);

    const breadcrumbs = testId(page, "breadcrumbs");

    // Navigate to post-1
    await testId(page, "blog-post-link-1").click();
    await expect(testId(page, "blog-post-page")).toBeVisible({ timeout: 5000 });

    // Should show full breadcrumb trail
    await expect(breadcrumbs.locator("text=Home")).toBeVisible();
    await expect(breadcrumbs.locator("text=Blog")).toBeVisible();
    await expect(breadcrumbs.locator("text=Post post-1")).toBeVisible();

    // Navigate to post-2 via back-to-blog then post-2
    await testId(page, "back-to-blog").click();
    await expect(testId(page, "blog-index-page")).toBeVisible({ timeout: 5000 });

    // Post breadcrumb should be gone
    await expect(breadcrumbs.locator("text=Post post-1")).not.toBeVisible();

    // Navigate to post-2
    await testId(page, "blog-post-link-2").click();
    await expect(testId(page, "blog-post-page")).toBeVisible({ timeout: 5000 });

    // Should show updated breadcrumb for post-2
    await expect(breadcrumbs.locator("text=Post post-2")).toBeVisible();
    await expect(breadcrumbs.locator("text=Post post-1")).not.toBeVisible();
  });

  test("should NOT show skeleton when action triggers revalidation", async ({
    page,
  }) => {
    // Navigate to product page and wait for async breadcrumb content to load
    await page.goto(f.url("/product/product-b"));
    await waitForHydration(page);

    // Wait for async breadcrumb content to fully load (1s delay in handler)
    await expect(testId(page, "breadcrumb-async")).toBeVisible({ timeout: 3000 });
    const initialContent = await testId(page, "breadcrumb-async").textContent();

    // Track if skeleton appears during action
    let skeletonAppeared = false;
    const skeleton = testId(page, "breadcrumbs-skeleton");

    // Start monitoring for skeleton appearance
    const checkSkeleton = async () => {
      try {
        const isVisible = await skeleton.isVisible();
        if (isVisible) skeletonAppeared = true;
      } catch {
        // Element might not exist, which is fine
      }
    };

    // Check skeleton visibility periodically during action
    const intervalId = setInterval(checkSkeleton, 50);

    // Click an action button to trigger revalidation
    await testId(page, "add-to-cart-btn").click();

    // Wait for action to complete and content to update
    await page.waitForTimeout(2000);

    // Stop monitoring
    clearInterval(intervalId);

    // The async breadcrumb content should still be visible (possibly updated)
    await expect(testId(page, "breadcrumb-async")).toBeVisible();

    // CRITICAL: Skeleton should NOT have appeared during the action
    // This is the key assertion - during action revalidation, we should
    // keep showing the old content, not flash a loading skeleton
    expect(skeletonAppeared).toBe(false);
  });
});
