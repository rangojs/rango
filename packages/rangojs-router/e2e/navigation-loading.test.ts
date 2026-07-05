import { expect, test } from "@playwright/test";
import { useFixture, type Fixture } from "./fixture";
import {
  waitForHydration,
  expectNoPageError,
  goBack,
  getHistoryState,
} from "./helper";

function runNavigationStateSpec(f: Fixture) {
  test("should pass state to loading skeleton via Link state prop", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/"));
    await waitForHydration(page);

    // Click slow product link (has state prop with productName and productPrice)
    const slowProductLink = page.locator('[data-testid="slow-product-link"]');
    await slowProductLink.click();

    // Modal with loading skeleton should appear
    await expect(
      page.locator('[data-testid="slow-product-modal"]'),
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="slow-modal-loading"]'),
    ).toBeVisible();

    // State should be available in skeleton - product name and price from Link state
    await expect(
      page.locator('[data-testid="slow-modal-state-name"]'),
    ).toHaveText("Slow Product A");
    await expect(
      page.locator('[data-testid="slow-modal-state-price"]'),
    ).toHaveText("$99");

    // Skeleton placeholders should NOT be visible since we have state
    await expect(
      page.locator('[data-testid="slow-modal-skeleton-name"]'),
    ).not.toBeVisible();
    await expect(
      page.locator('[data-testid="slow-modal-skeleton-price"]'),
    ).not.toBeVisible();
  });

  test("should show skeleton placeholders when Link has no state prop", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/"));
    await waitForHydration(page);

    // Click slow product link WITHOUT state prop
    const slowProductLink = page.locator(
      '[data-testid="slow-product-link-no-state"]',
    );
    await slowProductLink.click();

    // Modal with loading skeleton should appear
    await expect(
      page.locator('[data-testid="slow-product-modal"]'),
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="slow-modal-loading"]'),
    ).toBeVisible();

    // Without state, skeleton placeholders should be visible
    await expect(
      page.locator('[data-testid="slow-modal-skeleton-name"]'),
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="slow-modal-skeleton-price"]'),
    ).toBeVisible();

    // State elements should NOT be visible
    await expect(
      page.locator('[data-testid="slow-modal-state-name"]'),
    ).not.toBeVisible();
    await expect(
      page.locator('[data-testid="slow-modal-state-price"]'),
    ).not.toBeVisible();
  });

  test("should have state available in history after navigation completes", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/"));
    await waitForHydration(page);

    // Click slow product link with state
    const slowProductLink = page.locator('[data-testid="slow-product-link"]');
    await slowProductLink.click();

    // Wait for content to load
    await expect(
      page.locator('[data-testid="slow-modal-product-name"]'),
    ).toBeVisible();

    // Check history state contains our passed state (typed location state uses __rsc_ls_ prefix)
    // Key is auto-generated: __rsc_ls_src/location-states.ts#SlowProductLocationState
    const state = await getHistoryState(page);
    const locationStateKey = Object.keys(state || {}).find((k) =>
      k.includes("SlowProductLocationState"),
    );
    expect(locationStateKey).toBeDefined();
    const locationState = state?.[locationStateKey!];
    expect(locationState?.productName).toBe("Slow Product A");
    expect(locationState?.productPrice).toBe(99);
  });
}

function runInterceptLoadingSpec(f: Fixture) {
  test("should show loading skeleton in modal while slow loader resolves", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/"));
    await waitForHydration(page);

    // Click slow product link to open modal with slow loader
    const slowProductLink = page.locator('[data-testid="slow-product-link"]');
    await slowProductLink.click();

    // Modal should appear immediately with loading skeleton
    await expect(
      page.locator('[data-testid="slow-product-modal"]'),
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="slow-modal-loading"]'),
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="slow-modal-skeleton"]'),
    ).toBeVisible();

    // Background index content should still be visible
    await expect(page.locator('[data-testid="page-title"]')).toBeVisible();

    // Wait for loader to resolve (2s delay) - content should appear
    await expect(
      page.locator('[data-testid="slow-modal-product-name"]'),
    ).toBeVisible();

    // Loading skeleton should be gone
    await expect(
      page.locator('[data-testid="slow-modal-loading"]'),
    ).not.toBeVisible();

    // Modal should still show product content
    await expect(
      page.locator('[data-testid="slow-intercept-indicator"]'),
    ).toBeVisible();
  });

  test("should preserve background content while modal is loading", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/"));
    await waitForHydration(page);

    // Verify index content is visible before navigation
    await expect(page.locator('[data-testid="page-title"]')).toBeVisible();
    await expect(page.locator('[data-testid="product-list"]')).toBeVisible();

    // Click slow product link
    const slowProductLink = page.locator('[data-testid="slow-product-link"]');
    await slowProductLink.click();

    // Modal with loading state should appear
    await expect(
      page.locator('[data-testid="slow-product-modal"]'),
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="slow-modal-loading"]'),
    ).toBeVisible();

    // Background should remain visible throughout loading
    await expect(page.locator('[data-testid="page-title"]')).toBeVisible();
    await expect(page.locator('[data-testid="product-list"]')).toBeVisible();

    // Wait for content to load
    await expect(
      page.locator('[data-testid="slow-modal-product-name"]'),
    ).toBeVisible();

    // Background should still be visible after loading
    await expect(page.locator('[data-testid="page-title"]')).toBeVisible();
    await expect(page.locator('[data-testid="product-list"]')).toBeVisible();
  });

  test("should navigate back from loading modal", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/"));
    await waitForHydration(page);

    // Click slow product link
    const slowProductLink = page.locator('[data-testid="slow-product-link"]');
    await slowProductLink.click();

    // Modal with loading state should appear
    await expect(
      page.locator('[data-testid="slow-product-modal"]'),
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="slow-modal-loading"]'),
    ).toBeVisible();

    // Navigate back while still loading
    await goBack(page);

    // Should be back on index without modal
    await expect(page).toHaveURL(/\/$/);
    await expect(
      page.locator('[data-testid="slow-product-modal"]'),
    ).not.toBeVisible();
    await expect(page.locator('[data-testid="page-title"]')).toBeVisible();
  });

  test("should show full page on direct navigation bypassing intercept with loading", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // Navigate directly to slow product URL (document load)
    await page.goto(f.url("/slow-product/slow-product-a"));
    await waitForHydration(page);

    // Should NOT show intercepted modal or loading skeleton
    await expect(
      page.locator('[data-testid="slow-product-modal"]'),
    ).not.toBeVisible();
    await expect(
      page.locator('[data-testid="slow-modal-loading"]'),
    ).not.toBeVisible();

    // Should show full product detail page
    await expect(
      page.locator('[data-testid="slow-product-detail-page"]'),
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="slow-product-name"]'),
    ).toBeVisible();
  });

  test("should complete streaming action in intercepted modal", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/"));
    await waitForHydration(page);

    // Click slow product link to open modal
    const slowProductLink = page.locator('[data-testid="slow-product-link"]');
    await slowProductLink.click();

    // Wait for modal content to load (2s loader delay)
    await expect(
      page.locator('[data-testid="slow-modal-product-name"]'),
    ).toBeVisible();

    // Click streaming action button
    const streamingButton = page.locator(
      '[data-testid="slow-modal-streaming-btn"]',
    );
    await streamingButton.click();

    // Button should be disabled while processing
    await expect(streamingButton).toBeDisabled();

    // Modal should remain visible during action
    await expect(
      page.locator('[data-testid="slow-product-modal"]'),
    ).toBeVisible();

    // Background should remain visible during action
    await expect(page.locator('[data-testid="page-title"]')).toBeVisible();

    // Wait for action to complete (3s delay)
    await expect(
      page.locator('[data-testid="slow-modal-streaming-btn-result"]'),
    ).toContainText("Completed", { timeout: 10000 });

    // Modal should still be visible after action completes
    await expect(
      page.locator('[data-testid="slow-product-modal"]'),
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="slow-modal-product-name"]'),
    ).toBeVisible();
  });

  test("should handle back navigation during streaming action in modal", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/"));
    await waitForHydration(page);

    // Click slow product link to open modal
    const slowProductLink = page.locator('[data-testid="slow-product-link"]');
    await slowProductLink.click();

    // Wait for modal content to load
    await expect(
      page.locator('[data-testid="slow-modal-product-name"]'),
    ).toBeVisible();

    // Click streaming action button
    const streamingButton = page.locator(
      '[data-testid="slow-modal-streaming-btn"]',
    );
    await streamingButton.click();

    // Button should be disabled while processing
    await expect(streamingButton).toBeDisabled();

    // Navigate back while action is in progress
    await goBack(page);

    // Should be back on index without modal
    await expect(page).toHaveURL(/\/$/);
    await expect(
      page.locator('[data-testid="slow-product-modal"]'),
    ).not.toBeVisible();

    // Index should remain intact
    await expect(page.locator('[data-testid="page-title"]')).toBeVisible();
    await expect(page.locator('[data-testid="product-list"]')).toBeVisible();
  });

  test("should NOT show loading component during streaming action in modal", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/"));
    await waitForHydration(page);

    // Click slow product link to open modal
    const slowProductLink = page.locator('[data-testid="slow-product-link"]');
    await slowProductLink.click();

    // Wait for modal content to load (2s loader delay)
    await expect(
      page.locator('[data-testid="slow-modal-product-name"]'),
    ).toBeVisible();

    // Loading skeleton should be gone after content loads
    await expect(
      page.locator('[data-testid="slow-modal-loading"]'),
    ).not.toBeVisible();

    // Click streaming action button
    const streamingButton = page.locator(
      '[data-testid="slow-modal-streaming-btn"]',
    );
    await streamingButton.click();

    // Button should be disabled while processing
    await expect(streamingButton).toBeDisabled();

    // During streaming action: loading component should NOT appear
    // The content should remain visible, not replaced by loading skeleton
    await expect(
      page.locator('[data-testid="slow-modal-loading"]'),
    ).not.toBeVisible();
    await expect(
      page.locator('[data-testid="slow-modal-product-name"]'),
    ).toBeVisible();

    // Wait a bit to ensure loading doesn't appear during action
    await page.waitForTimeout(500);
    await expect(
      page.locator('[data-testid="slow-modal-loading"]'),
    ).not.toBeVisible();

    // Wait for action to complete
    await expect(
      page.locator('[data-testid="slow-modal-streaming-btn-result"]'),
    ).toContainText("Completed", { timeout: 10000 });

    // After action completes: still no loading component, content visible
    await expect(
      page.locator('[data-testid="slow-modal-loading"]'),
    ).not.toBeVisible();
    await expect(
      page.locator('[data-testid="slow-modal-product-name"]'),
    ).toBeVisible();
  });
}

test.describe("navigation-state (dev)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });
  runNavigationStateSpec(f);
});

test.describe("navigation-state (production)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "build",
  });
  runNavigationStateSpec(f);
});

test.describe("intercept-loading-states (dev)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });
  runInterceptLoadingSpec(f);
});

test.describe("intercept-loading-states (production)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "build",
  });
  runInterceptLoadingSpec(f);
});
