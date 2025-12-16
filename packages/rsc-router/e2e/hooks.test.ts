import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError } from "./helper";

/**
 * Tests for useNavigation and useAction hooks
 */
test.describe("useNavigation", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });

  test("should show idle state on initial load", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/"));
    await waitForHydration(page);

    // Navigation status should show idle state
    await expect(page.locator('[data-testid="nav-status-state"]')).toContainText(
      "state:idle"
    );
    await expect(
      page.locator('[data-testid="nav-status-streaming"]')
    ).toContainText("streaming:false");
    await expect(
      page.locator('[data-testid="nav-status-pathname"]')
    ).toContainText("path:/");
  });

  test("should transition to loading during navigation", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/"));
    await waitForHydration(page);

    // Initial state should be idle
    await expect(page.locator('[data-testid="nav-status-state"]')).toContainText(
      "state:idle"
    );

    // Start navigation to slow route (no loading component = awaited)
    const slowLink = page.locator('[data-testid="slow-link"]');
    await slowLink.click();

    // Should transition to loading state
    await expect(page.locator('[data-testid="nav-status-state"]')).toContainText(
      "state:loading",
      { timeout: 2000 }
    );

    // Wait for navigation to complete
    await expect(page.locator('[data-testid="slow-page"]')).toBeVisible({
      timeout: 5000,
    });

    // Should return to idle state
    await expect(page.locator('[data-testid="nav-status-state"]')).toContainText(
      "state:idle"
    );
  });

  test("should show streaming state during streaming navigation", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/"));
    await waitForHydration(page);

    // Initial state should be idle, not streaming
    await expect(page.locator('[data-testid="nav-status-state"]')).toContainText(
      "state:idle"
    );
    await expect(
      page.locator('[data-testid="nav-status-streaming"]')
    ).toContainText("streaming:false");

    // Navigate to streaming route (has loading component)
    const streamingLink = page.locator('[data-testid="slow-streaming-link"]');
    await streamingLink.click();

    // Should show loading skeleton (streaming)
    await expect(
      page.locator('[data-testid="slow-streaming-loading"]')
    ).toBeVisible({ timeout: 2000 });

    // During streaming, isStreaming should be true
    await expect(
      page.locator('[data-testid="nav-status-streaming"]')
    ).toContainText("streaming:true", { timeout: 2000 });

    // Wait for content to load
    await expect(
      page.locator('[data-testid="slow-streaming-page"]')
    ).toBeVisible({ timeout: 5000 });

    // After streaming completes, should return to not streaming
    await expect(
      page.locator('[data-testid="nav-status-streaming"]')
    ).toContainText("streaming:false", { timeout: 2000 });
  });

  test("should update pathname during navigation", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/"));
    await waitForHydration(page);

    // Initial pathname should be /
    await expect(
      page.locator('[data-testid="nav-status-pathname"]')
    ).toContainText("path:/");

    // Navigate to product
    const productLink = page.locator('[data-testid="product-link-product-a"]');
    await productLink.click();

    // Pathname should update to product URL
    await expect(
      page.locator('[data-testid="nav-status-pathname"]')
    ).toContainText("path:/product/product-a", { timeout: 2000 });
  });

  test("should update pathname on back navigation", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/"));
    await waitForHydration(page);

    // Navigate to product
    const productLink = page.locator('[data-testid="product-link-product-a"]');
    await productLink.click();
    await expect(
      page.locator('[data-testid="nav-status-pathname"]')
    ).toContainText("path:/product/product-a", { timeout: 2000 });

    // Navigate back
    await page.goBack();

    // Pathname should return to /
    await expect(
      page.locator('[data-testid="nav-status-pathname"]')
    ).toContainText("path:/", { timeout: 2000 });
  });
});

test.describe("useAction", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });

  test("should show idle state before action", async ({ page }) => {
    using _ = expectNoPageError(page);

    // Navigate directly to product detail page
    await page.goto(f.url("/product/product-a"));
    await waitForHydration(page);

    // Action status should show idle state
    await expect(
      page.locator('[data-testid="StreamingActionStatus-action-status"]')
    ).toContainText("Action status: idle");
  });

  test("should transition through loading and streaming states", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/product/product-a"));
    await waitForHydration(page);

    // Initial state should be idle
    const actionStatus = page.locator(
      '[data-testid="StreamingActionStatus-action-status"]'
    );
    await expect(actionStatus).toContainText("Action status: idle");

    // Click streaming action button
    const button = page.locator('[data-testid="streaming-btn"]');
    await button.click();

    // Should transition to loading
    await expect(actionStatus).toContainText("Action status: loading", {
      timeout: 2000,
    });

    // Should transition to streaming
    await expect(actionStatus).toContainText("Action status: streaming", {
      timeout: 5000,
    });

    // Wait for action to complete
    await expect(
      page.locator('[data-testid="streaming-btn-result"]')
    ).toContainText("Completed", { timeout: 10000 });

    // Should return to idle
    await expect(actionStatus).toContainText("Action status: idle", {
      timeout: 5000,
    });
  });

  test("should track action state after navigation", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/"));
    await waitForHydration(page);

    // Navigate to product detail via intercept then full details
    const productLink = page.locator('[data-testid="product-link-product-a"]');
    await productLink.click();
    await expect(page.locator('[data-testid="product-modal"]')).toBeVisible();

    // Go to full details
    await page.locator('[data-testid="view-full-details"]').click();
    await expect(page.locator('[data-testid="segment-metadata"]')).toBeVisible();

    // Action status should show idle
    const actionStatus = page.locator(
      '[data-testid="StreamingActionStatus-action-status"]'
    );
    await expect(actionStatus).toContainText("Action status: idle");

    // Click streaming action
    const button = page.locator('[data-testid="streaming-btn"]');
    await button.click();

    // Should track action through lifecycle
    await expect(actionStatus).toContainText("Action status: loading", {
      timeout: 2000,
    });

    await expect(
      page.locator('[data-testid="streaming-btn-result"]')
    ).toContainText("Completed", { timeout: 10000 });

    await expect(actionStatus).toContainText("Action status: idle", {
      timeout: 5000,
    });
  });

  test("should work with quick actions (add to cart)", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/product/product-a"));
    await waitForHydration(page);

    // Click add to cart button
    const addToCartBtn = page.locator('[data-testid="add-to-cart-btn"]');
    await addToCartBtn.click();

    // Should show result when action completes
    await expect(
      page.locator('[data-testid="add-to-cart-btn-result"]')
    ).toBeVisible({ timeout: 5000 });
  });
});

test.describe("useNavigation during actions", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });

  test("should remain idle during server action", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/product/product-a"));
    await waitForHydration(page);

    // Navigation should be idle initially
    await expect(page.locator('[data-testid="nav-status-state"]')).toContainText(
      "state:idle"
    );

    // Click streaming action
    const button = page.locator('[data-testid="streaming-btn"]');
    await button.click();

    // Action should be in progress
    await expect(
      page.locator('[data-testid="StreamingActionStatus-action-status"]')
    ).toContainText("loading", { timeout: 2000 });

    // Navigation state should still be idle (actions don't affect navigation state)
    await expect(page.locator('[data-testid="nav-status-state"]')).toContainText(
      "state:idle"
    );

    // Wait for action to complete
    await expect(
      page.locator('[data-testid="streaming-btn-result"]')
    ).toContainText("Completed", { timeout: 10000 });
  });

  test("should track navigation and action independently", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/"));
    await waitForHydration(page);

    // Navigate to product modal
    const productLink = page.locator('[data-testid="product-link-product-a"]');
    await productLink.click();
    await expect(page.locator('[data-testid="product-modal"]')).toBeVisible();

    // Go to full details
    await page.locator('[data-testid="view-full-details"]').click();
    await expect(page.locator('[data-testid="segment-metadata"]')).toBeVisible();

    // Start streaming action
    const button = page.locator('[data-testid="streaming-btn"]');
    await button.click();

    // Action should be loading
    await expect(
      page.locator('[data-testid="StreamingActionStatus-action-status"]')
    ).toContainText("loading", { timeout: 2000 });

    // Navigate back while action is running
    await page.goBack();

    // Should show modal (intercept view)
    await expect(page.locator('[data-testid="product-modal"]')).toBeVisible({
      timeout: 2000,
    });

    // Navigation should return to idle after popstate
    await expect(page.locator('[data-testid="nav-status-state"]')).toContainText(
      "state:idle",
      { timeout: 2000 }
    );
  });
});
