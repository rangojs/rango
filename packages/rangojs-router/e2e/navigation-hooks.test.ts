import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration } from "./helper";

test.describe("use-segments-hook", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });

  test("should display segments on index and update on navigation", async ({
    page,
  }) => {
    // Capture errors and logs for debugging
    const errors: Error[] = [];
    const logs: string[] = [];
    page.on("pageerror", (error) => {
      console.log("Page error:", error.message);
      errors.push(error);
    });
    page.on("console", (msg) => {
      if (
        msg.text().includes("[SegmentsDisplay]") ||
        msg.text().includes("[useSegments]")
      ) {
        logs.push(msg.text());
      }
    });

    await page.goto(f.url("/"));
    await waitForHydration(page);

    // Wait a bit for component to mount and log
    await page.waitForTimeout(500);
    console.log("Browser logs:", logs);

    // Check segments display is visible with correct initial values
    const segmentsDisplay = page.locator('[data-testid="segments-display"]');
    await expect(segmentsDisplay).toBeVisible();

    // Path should be empty array for root
    await expect(page.locator('[data-testid="segments-path"]')).toContainText(
      "[]",
    );

    // Pathname should show /
    await expect(
      page.locator('[data-testid="segments-pathname"]'),
    ).toContainText("Pathname: /");

    // Should have segment IDs
    await expect(page.locator('[data-testid="segments-ids"]')).toContainText(
      "M0L0",
    );

    // Navigate to product page
    await page.locator('[data-testid="product-link-product-a"]').click();
    await expect(page).toHaveURL(/\/product\/product-a/);

    // Path should update
    await expect(page.locator('[data-testid="segments-path"]')).toContainText(
      '["product","product-a"]',
    );

    // Pathname should update
    await expect(
      page.locator('[data-testid="segments-pathname"]'),
    ).toContainText("/product/product-a");

    // Log any errors for debugging
    if (errors.length > 0) {
      console.log(
        "Captured page errors:",
        errors.map((e) => e.message).join("\n"),
      );
    }
    expect(errors).toEqual([]);
  });
});

test.describe("use-link-status-hook", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });

  test("should show pending state only on clicked link", async ({ page }) => {
    await page.goto(f.url("/"));
    await waitForHydration(page);

    // All badges should start as idle
    const slowBadge = page.locator(
      '[data-testid="link-status-slow"] [data-testid="link-pending-badge"]',
    );
    const streamingBadge = page.locator(
      '[data-testid="link-status-slow-streaming"] [data-testid="link-pending-badge"]',
    );
    const blogBadge = page.locator(
      '[data-testid="link-status-blog"] [data-testid="link-pending-badge"]',
    );

    await expect(slowBadge).toHaveAttribute("data-pending", "false");
    await expect(streamingBadge).toHaveAttribute("data-pending", "false");
    await expect(blogBadge).toHaveAttribute("data-pending", "false");

    // Click slow link - it should become pending, others stay idle
    await page.locator('[data-testid="link-status-slow"]').click();

    // Slow link should be pending
    await expect(slowBadge).toHaveAttribute("data-pending", "true");

    // Other links should remain idle
    await expect(streamingBadge).toHaveAttribute("data-pending", "false");
    await expect(blogBadge).toHaveAttribute("data-pending", "false");

    // Wait for navigation to complete
    await expect(page).toHaveURL(/\/slow/);
  });

  test("should update pending state on concurrent clicks (last wins)", async ({
    page,
  }) => {
    await page.goto(f.url("/"));
    await waitForHydration(page);

    const slowBadge = page.locator(
      '[data-testid="link-status-slow"] [data-testid="link-pending-badge"]',
    );
    const streamingBadge = page.locator(
      '[data-testid="link-status-slow-streaming"] [data-testid="link-pending-badge"]',
    );

    // Click slow link first (takes ~1s to load, no loading state)
    await page.locator('[data-testid="link-status-slow"]').click();

    // Slow should be pending initially
    await expect(slowBadge).toHaveAttribute("data-pending", "true");

    // Click streaming link (this cancels slow navigation and navigates to streaming route)
    // The streaming route has a loading state, so we navigate immediately
    await page.locator('[data-testid="link-status-slow-streaming"]').click();

    // We should navigate to the streaming page (last click wins)
    // This confirms the slow navigation was cancelled
    await expect(page).toHaveURL(/\/slow-streaming/);

    // Navigate back to verify the slow route was never loaded
    await page.goBack();
    await expect(page).toHaveURL(/\/$/);

    // Badges should be idle
    await expect(slowBadge).toHaveAttribute("data-pending", "false");
    await expect(streamingBadge).toHaveAttribute("data-pending", "false");
  });

  test("should reset pending state when navigation completes", async ({
    page,
  }) => {
    await page.goto(f.url("/"));
    await waitForHydration(page);

    const blogBadge = page.locator(
      '[data-testid="link-status-blog"] [data-testid="link-pending-badge"]',
    );

    // Click blog link (fast navigation)
    await page.locator('[data-testid="link-status-blog"]').click();

    // Wait for navigation - should end up on blog page
    await expect(page).toHaveURL(/\/blog/);

    // Go back to index
    await page.goBack();
    await expect(page).toHaveURL(/\/$/);

    // Badge should be idle again
    await expect(blogBadge).toHaveAttribute("data-pending", "false");
  });

  test("should NOT show pending state during server actions", async ({
    page,
  }) => {
    // Navigate to product page which has action buttons
    await page.goto(f.url("/product/product-a"));
    await waitForHydration(page);

    // Get the back link badge on product page
    const backLink = page.locator('[data-testid="back-link"]');

    // Note: the back link doesn't have a badge, but we can check navigation state
    // Click streaming action button (3s delay)
    const streamingButton = page.locator('[data-testid="streaming-btn"]');
    await streamingButton.click();

    // Action should be in progress (button disabled)
    await expect(streamingButton).toBeDisabled();

    // Navigation state should still be idle (not loading from action)
    const navState = page.locator('[data-testid="nav-status-state"]');
    await expect(navState).toContainText("idle");

    // Wait for action to complete
    await expect(
      page.locator('[data-testid="streaming-btn-result"]'),
    ).toContainText("Completed", { timeout: 10000 });
  });

  test("should resolve pending state when intercept navigation completes", async ({
    page,
  }) => {
    await page.goto(f.url("/"));
    await waitForHydration(page);

    // Get the product link badge
    const productBadge = page.locator(
      '[data-testid="product-link-product-a"] [data-testid="link-pending-badge"]',
    );

    // Initially should be idle
    await expect(productBadge).toHaveAttribute("data-pending", "false");

    // Click product link to open modal (intercept)
    await page.locator('[data-testid="product-link-product-a"]').click();

    // Modal should appear (intercept completed)
    await expect(page.locator('[data-testid="product-modal"]')).toBeVisible();

    // URL should change
    await expect(page).toHaveURL(/\/product\/product-a/);

    // Go back to index
    await page.goBack();
    await expect(page).toHaveURL(/\/$/);

    // Badge should be idle after popstate
    await expect(productBadge).toHaveAttribute("data-pending", "false");
  });

  test("should not show pending state after popstate (back navigation)", async ({
    page,
  }) => {
    await page.goto(f.url("/"));
    await waitForHydration(page);

    const productBadge = page.locator(
      '[data-testid="product-link-product-a"] [data-testid="link-pending-badge"]',
    );

    // Click product to open modal
    await page.locator('[data-testid="product-link-product-a"]').click();
    await expect(page.locator('[data-testid="product-modal"]')).toBeVisible();

    // Navigate to detail page
    await page.locator('[data-testid="view-full-details"]').click();
    await expect(
      page.locator('[data-testid="segment-metadata"]'),
    ).toBeVisible();

    // Go back to modal
    await page.goBack();
    await expect(page.locator('[data-testid="product-modal"]')).toBeVisible();

    // Go back to index
    await page.goBack();
    await expect(page).toHaveURL(/\/$/);

    // Badge should be idle - popstate should not trigger pending
    await expect(productBadge).toHaveAttribute("data-pending", "false");
  });

  test("should handle back navigation during slow navigation without pending state leak", async ({
    page,
  }) => {
    // First navigate to blog to create history entry
    await page.goto(f.url("/blog"));
    await waitForHydration(page);

    // Now navigate to index (creates history: blog -> index)
    await page.goto(f.url("/"));
    await waitForHydration(page);

    const slowBadge = page.locator(
      '[data-testid="link-status-slow"] [data-testid="link-pending-badge"]',
    );

    // Click slow link (starts slow navigation)
    await page.locator('[data-testid="link-status-slow"]').click();

    // Should be pending
    await expect(slowBadge).toHaveAttribute("data-pending", "true");

    // Go back while still loading (this should cancel the navigation and go to blog)
    await page.goBack();

    // Should be on blog page now
    await expect(page).toHaveURL(/\/blog/);

    // Navigate forward to index
    await page.goForward();
    await expect(page).toHaveURL(/\/$/);

    // Badge should be idle - the slow navigation was cancelled
    await expect(slowBadge).toHaveAttribute("data-pending", "false");
  });

  test("should not show pending during forward navigation (popstate)", async ({
    page,
  }) => {
    await page.goto(f.url("/"));
    await waitForHydration(page);

    const productBadge = page.locator(
      '[data-testid="product-link-product-a"] [data-testid="link-pending-badge"]',
    );

    // Navigate to product (intercept)
    await page.locator('[data-testid="product-link-product-a"]').click();
    await expect(page.locator('[data-testid="product-modal"]')).toBeVisible();

    // Go back to index
    await page.goBack();
    await expect(page).toHaveURL(/\/$/);
    await expect(productBadge).toHaveAttribute("data-pending", "false");

    // Go forward (popstate) to product
    await page.goForward();
    await expect(page).toHaveURL(/\/product\/product-a/);

    // Go back again
    await page.goBack();
    await expect(page).toHaveURL(/\/$/);

    // Badge should still be idle - no pending state from popstate
    await expect(productBadge).toHaveAttribute("data-pending", "false");
  });
});
