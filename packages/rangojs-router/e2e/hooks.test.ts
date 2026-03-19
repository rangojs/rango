import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError, goBack } from "./helper";

/**
 * Tests for useNavigation and useAction hooks
 */
test.describe.configure({ mode: "serial" });

test.describe("useNavigation", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
    isolatedServer: true,
  });

  test("should show idle state on initial load", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/"));
    await waitForHydration(page);

    // Navigation status should show idle state
    await expect(
      page.locator('[data-testid="nav-status-state"]'),
    ).toContainText("state:idle");
    await expect(
      page.locator('[data-testid="nav-status-streaming"]'),
    ).toContainText("streaming:false");
    await expect(
      page.locator('[data-testid="nav-status-pathname"]'),
    ).toContainText("path:/");
  });

  test("should transition to loading during navigation", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/"));
    await waitForHydration(page);

    // Initial state should be idle
    await expect(
      page.locator('[data-testid="nav-status-state"]'),
    ).toContainText("state:idle");

    // Extra wait to ensure all event handlers are attached
    // Under load, React hydration might complete but handlers may still be attaching
    await page.waitForTimeout(100);

    const loadingStateSeen = page
      .waitForFunction(
        () =>
          document
            .querySelector('[data-testid="nav-status-state"]')
            ?.textContent?.includes("loading") ?? false,
        undefined,
        { timeout: 4000 },
      )
      .then(() => true)
      .catch(() => false);

    // Start navigation to slow route (no loading component = awaited)
    const slowLink = page.locator('[data-testid="slow-link"]');

    // Click and wait for URL to change, with retry logic for robustness
    let retries = 3;
    while (retries > 0) {
      const navigationPromise = page
        .waitForURL("**/slow", { timeout: 10000 })
        .catch(() => null);
      await slowLink.click();

      const result = await navigationPromise;
      if (result !== null || page.url().includes("/slow")) {
        break;
      }
      retries--;
      if (retries > 0) {
        // Wait a bit before retrying
        await page.waitForTimeout(500);
      }
    }

    // Verify the page loaded
    await expect(page.locator('[data-testid="slow-page"]')).toBeVisible({
      timeout: 10000,
    });

    const sawLoading = await loadingStateSeen;

    // The slow route takes ~1s, so we should have seen loading state
    expect(sawLoading).toBe(true);

    // Should return to idle state after navigation completes
    await expect(
      page.locator('[data-testid="nav-status-state"]'),
    ).toContainText("state:idle", { timeout: 5000 });
  });

  test("should show streaming state during streaming navigation", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/"));
    await waitForHydration(page);

    // Initial state should be idle, not streaming
    await expect(
      page.locator('[data-testid="nav-status-state"]'),
    ).toContainText("state:idle");
    await expect(
      page.locator('[data-testid="nav-status-streaming"]'),
    ).toContainText("streaming:false");

    await page.evaluate(() => {
      (
        window as typeof window & { __sawStreamingState?: boolean }
      ).__sawStreamingState = false;
      const observer = new MutationObserver(() => {
        const streamingEl = document.querySelector(
          '[data-testid="nav-status-streaming"]',
        );
        if (streamingEl?.textContent?.includes("streaming:true")) {
          (
            window as typeof window & { __sawStreamingState?: boolean }
          ).__sawStreamingState = true;
        }
      });
      const target = document.querySelector('[data-testid="nav-status"]');
      if (target) {
        observer.observe(target, {
          childList: true,
          subtree: true,
          characterData: true,
        });
      }
      (
        window as typeof window & {
          __streamingStateObserver?: MutationObserver;
        }
      ).__streamingStateObserver = observer;
    });

    // Navigate to streaming route (has loading component)
    const streamingLink = page.locator('[data-testid="slow-streaming-link"]');
    await streamingLink.click();

    // Should show loading skeleton (streaming)
    await expect(
      page.locator('[data-testid="slow-streaming-loading"]'),
    ).toBeVisible({ timeout: 2000 });

    // Wait for content to load
    await expect(
      page.locator('[data-testid="slow-streaming-page"]'),
    ).toBeVisible({ timeout: 5000 });

    const sawStreaming = await page.evaluate(() => {
      (
        window as typeof window & {
          __streamingStateObserver?: MutationObserver;
        }
      ).__streamingStateObserver?.disconnect();
      return !!(window as typeof window & { __sawStreamingState?: boolean })
        .__sawStreamingState;
    });

    expect(sawStreaming).toBe(true);

    // After streaming completes, should return to not streaming
    await expect(
      page.locator('[data-testid="nav-status-streaming"]'),
    ).toContainText("streaming:false", { timeout: 2000 });
  });

  test("should update pathname during navigation", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/"));
    await waitForHydration(page);

    // Initial pathname should be /
    await expect(
      page.locator('[data-testid="nav-status-pathname"]'),
    ).toContainText("path:/");

    // Navigate to product
    const productLink = page.locator('[data-testid="product-link-product-a"]');
    await productLink.click();

    // Pathname should update to product URL
    await expect(
      page.locator('[data-testid="nav-status-pathname"]'),
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
      page.locator('[data-testid="nav-status-pathname"]'),
    ).toContainText("path:/product/product-a", { timeout: 5000 });

    // Navigate back and wait for navigation to complete
    await goBack(page);

    // Pathname should return to /
    await expect(
      page.locator('[data-testid="nav-status-pathname"]'),
    ).toContainText("path:/", { timeout: 5000 });
  });
});

test.describe("useAction", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
    isolatedServer: true,
  });

  test("should show idle state before action", async ({ page }) => {
    using _ = expectNoPageError(page);

    // Navigate directly to product detail page
    await page.goto(f.url("/product/product-a"));
    await waitForHydration(page);

    // Action status should show idle state
    await expect(
      page.locator('[data-testid="StreamingActionStatus-action-status"]'),
    ).toContainText("Action status: idle");
  });

  test("should transition through loading and settle after a streaming action", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/product/product-a"));
    await waitForHydration(page);

    // Initial state should be idle
    const actionStatus = page.locator(
      '[data-testid="StreamingActionStatus-action-status"]',
    );
    await expect(actionStatus).toContainText("Action status: idle");

    // Click streaming action button
    const button = page.locator('[data-testid="streaming-btn"]');
    await button.click();

    // Should transition to loading
    await expect(actionStatus).toContainText("Action status: loading", {
      timeout: 2000,
    });

    // Hooks coverage here should focus on action state transitions, not the
    // streamed result DOM. The dedicated streaming-actions suite covers the
    // Suspense fallback/result markup in both direct and SPA paths.
    await expect(button).toContainText("Processing...");

    // The action should settle back to idle and restore the button affordance.
    await expect(actionStatus).toContainText("Action status: idle", {
      timeout: 10000,
    });
    await expect(button).toContainText("Streaming Action", { timeout: 5000 });
    await expect(button).toBeEnabled();
  });

  test("should track action state after client navigation", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/"));
    await waitForHydration(page);

    // Navigate to product detail. Depending on intercept timing and client state,
    // this may land in the modal first or go straight to the full detail page.
    const productLink = page.locator('[data-testid="product-link-product-a"]');
    await productLink.click();
    const productModal = page.locator('[data-testid="product-modal"]');
    const productDetail = page.locator('[data-testid="segment-metadata"]');

    await expect
      .poll(
        async () => {
          if (await productModal.isVisible()) return "modal";
          if (await productDetail.isVisible()) return "detail";
          return "pending";
        },
        {
          timeout: 5000,
          message: "Expected product navigation to reach modal or full detail",
        },
      )
      .not.toBe("pending");

    if (await productModal.isVisible()) {
      await page.locator('[data-testid="view-full-details"]').click();
    }
    await expect(productDetail).toBeVisible();

    // Action status should show idle
    const actionStatus = page.locator(
      '[data-testid="StreamingActionStatus-action-status"]',
    );
    await expect(actionStatus).toContainText("Action status: idle");

    // Click streaming action
    const button = page.locator('[data-testid="streaming-btn"]');
    await button.click();

    // Should track action through lifecycle
    await expect(actionStatus).toContainText("Action status: loading", {
      timeout: 2000,
    });

    await expect(actionStatus).toContainText("Action status: idle", {
      timeout: 10000,
    });
    await expect(button).toContainText("Streaming Action", { timeout: 5000 });
    await expect(button).toBeEnabled();
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
      page.locator('[data-testid="add-to-cart-btn-result"]'),
    ).toBeVisible({ timeout: 5000 });
  });
});

test.describe("useNavigation during actions", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
    isolatedServer: true,
  });

  test("should remain idle during server action", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/product/product-a"));
    await waitForHydration(page);

    // Navigation should be idle initially
    await expect(
      page.locator('[data-testid="nav-status-state"]'),
    ).toContainText("state:idle");

    // Click streaming action
    const button = page.locator('[data-testid="streaming-btn"]');
    await button.click();

    // Action should be in progress
    await expect(
      page.locator('[data-testid="StreamingActionStatus-action-status"]'),
    ).toContainText("loading", { timeout: 2000 });

    // Navigation state should still be idle (actions don't affect navigation state)
    await expect(
      page.locator('[data-testid="nav-status-state"]'),
    ).toContainText("state:idle");

    // Wait for action to settle; the streaming-actions suite owns the actual
    // streamed result DOM assertions, while this test verifies navigation
    // state remains idle throughout the server action lifecycle.
    await expect(
      page.locator('[data-testid="StreamingActionStatus-action-status"]'),
    ).toContainText("idle", { timeout: 10000 });
    await expect(
      page.locator('[data-testid="nav-status-state"]'),
    ).toContainText("state:idle");
  });

  test("should track navigation and action independently", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/"));
    await waitForHydration(page);

    // Navigate to product detail. Under heavier dev load this can land in the
    // intercept modal first or, more rarely, jump straight to full details.
    const productLink = page.locator('[data-testid="product-link-product-a"]');
    await productLink.click();
    const productModal = page.locator('[data-testid="product-modal"]');
    const productDetail = page.locator('[data-testid="segment-metadata"]');

    await expect
      .poll(
        async () => {
          if (await productModal.isVisible()) return "modal";
          if (await productDetail.isVisible()) return "detail";
          return "pending";
        },
        {
          timeout: 5000,
          message: "Expected product navigation to reach modal or full detail",
        },
      )
      .not.toBe("pending");

    if (await productModal.isVisible()) {
      await page.locator('[data-testid="view-full-details"]').click();
    }
    await expect(productDetail).toBeVisible();

    // Start streaming action
    const button = page.locator('[data-testid="streaming-btn"]');
    await button.click();

    // Action should be loading
    await expect(
      page.locator('[data-testid="StreamingActionStatus-action-status"]'),
    ).toContainText("loading", { timeout: 2000 });

    // Navigate back while action is running
    await page.goBack();

    // Going back while the action is still running should restore an earlier
    // navigation surface without leaving navigation state stuck in loading.
    await expect
      .poll(
        async () => {
          if (await productModal.isVisible()) return "modal";
          if (await page.locator('[data-testid="home-page"]').isVisible()) {
            return "home";
          }
          return "pending";
        },
        {
          timeout: 5000,
          message: "Expected back navigation to restore modal or home view",
        },
      )
      .not.toBe("pending");

    // Navigation should return to idle after popstate
    await expect(
      page.locator('[data-testid="nav-status-state"]'),
    ).toContainText("state:idle", { timeout: 2000 });
  });
});

/**
 * Production build tests for useNavigation and useAction hooks
 */
test.describe("useNavigation (production)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "build",
  });

  test.setTimeout(120000);

  test("should show idle state on initial load", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/"));
    await waitForHydration(page);

    await expect(
      page.locator('[data-testid="nav-status-state"]'),
    ).toContainText("state:idle");
    await expect(
      page.locator('[data-testid="nav-status-streaming"]'),
    ).toContainText("streaming:false");
  });

  test("should update pathname during navigation", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/"));
    await waitForHydration(page);

    // Initial pathname
    await expect(
      page.locator('[data-testid="nav-status-pathname"]'),
    ).toContainText("path:/");

    // Navigate to product
    await page.locator('[data-testid="product-link-product-a"]').click();

    // Pathname should update
    await expect(
      page.locator('[data-testid="nav-status-pathname"]'),
    ).toContainText("path:/product/product-a", { timeout: 5000 });
  });
});

test.describe("useAction (production)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "build",
  });

  test.setTimeout(120000);

  test("should show idle state and settle after a streaming action", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/product/product-a"));
    await waitForHydration(page);

    // Initial state should be idle
    await expect(
      page.locator('[data-testid="StreamingActionStatus-action-status"]'),
    ).toContainText("Action status: idle");

    // Click streaming action button
    await page.locator('[data-testid="streaming-btn"]').click();

    // Should transition through loading
    await expect(
      page.locator('[data-testid="StreamingActionStatus-action-status"]'),
    ).toContainText("Action status: loading", { timeout: 2000 });

    const button = page.locator('[data-testid="streaming-btn"]');
    await expect(button).toContainText("Processing...");

    // The action should settle back to idle and restore the button affordance.
    await expect(
      page.locator('[data-testid="StreamingActionStatus-action-status"]'),
    ).toContainText("Action status: idle", { timeout: 10000 });
    await expect(button).toContainText("Streaming Action", { timeout: 5000 });
    await expect(button).toBeEnabled();
  });

  test("quick actions work in production", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/product/product-a"));
    await waitForHydration(page);

    // Click add to cart
    await page.locator('[data-testid="add-to-cart-btn"]').click();

    // Should show result
    await expect(
      page.locator('[data-testid="add-to-cart-btn-result"]'),
    ).toBeVisible({ timeout: 5000 });
  });
});
