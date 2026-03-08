import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, testId, goBack } from "./helper";

/**
 * Shared error boundary tests run against both dev and production.
 *
 * Contract under test:
 * - Client errors caught by RootErrorBoundary, fallback UI rendered
 * - Server errors caught during RSC render, fallback UI rendered
 * - Streaming errors show loading then fallback
 * - RootErrorBoundary replaces the entire segment tree (app shell is NOT preserved)
 * - Navigation away from error boundary recovers the app
 * - Back navigation from error boundary recovers the app
 */
function errorBoundaryTests(f: ReturnType<typeof useFixture>, isDev: boolean) {
  test.describe("client-component-errors", () => {
    test("should show error boundary when client component throws on interaction", async ({
      page,
    }) => {
      await page.goto(f.url("/errors/client-error"));
      await waitForHydration(page);

      await expect(testId(page, "client-error-title")).toBeVisible();
      await expect(testId(page, "client-error-thrower")).toBeVisible();

      await testId(page, "client-error-thrower-trigger").click();

      // RootErrorBoundary shows "Internal Server Error" fallback
      await expect(page.getByText("Internal Server Error")).toBeVisible({
        timeout: 5000,
      });

      // Detailed error message is only shown in dev mode
      if (isDev) {
        await expect(
          page.getByText("Client-side error", { exact: false }).first(),
        ).toBeVisible();
      }
    });

    test("client error replaces segment tree with error fallback", async ({
      page,
    }) => {
      await page.goto(f.url("/errors/client-error"));
      await waitForHydration(page);

      // Verify layout elements exist before the error
      await expect(testId(page, "app-root")).toBeVisible();
      await expect(testId(page, "nav")).toBeVisible();
      await expect(testId(page, "client-error-title")).toBeVisible();

      // Trigger the error
      await testId(page, "client-error-thrower-trigger").click();

      // RootErrorBoundary replaces the segment tree
      await expect(page.getByText("Internal Server Error")).toBeVisible({
        timeout: 5000,
      });

      // The route content is gone (replaced by error fallback)
      await expect(testId(page, "client-error-title")).not.toBeVisible();

      // Error fallback provides recovery links
      await expect(page.getByText("Try Again")).toBeVisible();
      await expect(page.getByText("Go to homepage")).toBeVisible();
    });
  });

  test.describe("server-component-errors", () => {
    test("should show error boundary for server component error", async ({
      page,
    }) => {
      await page.goto(f.url("/errors/server-error"));

      await expect(page.getByText("Internal Server Error")).toBeVisible({
        timeout: 5000,
      });

      if (isDev) {
        await expect(
          page.getByText("Server error", { exact: false }).first(),
        ).toBeVisible();
      }
    });

    test("should show error boundary on SPA navigation to server error", async ({
      page,
    }) => {
      await page.goto(f.url("/errors"));
      await waitForHydration(page);

      await expect(testId(page, "errors-title")).toBeVisible();

      await testId(page, "server-error-link").click();

      await expect(page.getByText("Internal Server Error")).toBeVisible({
        timeout: 5000,
      });
    });
  });

  test.describe("streaming-errors", () => {
    test("should show loading then error boundary for streaming error", async ({
      page,
    }) => {
      await page.goto(f.url("/errors/streaming-error"));

      // Should briefly show loading state
      await expect(
        testId(page, "main-content").locator(
          '[data-testid="streaming-error-loading"]',
        ),
      ).toBeVisible({
        timeout: 2000,
      });

      // Then the error boundary should appear
      await expect(page.getByText("Internal Server Error")).toBeVisible({
        timeout: 5000,
      });

      if (isDev) {
        await expect(
          page.getByText("Streaming error", { exact: false }).first(),
        ).toBeVisible();
      }
    });

    test("should handle SPA navigation to streaming error route", async ({
      page,
    }) => {
      await page.goto(f.url("/errors"));
      await waitForHydration(page);

      await testId(page, "streaming-error-link").click();

      await expect(
        testId(page, "main-content").locator(
          '[data-testid="streaming-error-loading"]',
        ),
      ).toBeVisible({
        timeout: 2000,
      });

      await expect(page.getByText("Internal Server Error")).toBeVisible({
        timeout: 5000,
      });
    });
  });

  test.describe("navigation-after-error", () => {
    test("should be able to navigate away from error boundary", async ({
      page,
    }) => {
      await page.goto(f.url("/errors/server-error"));

      await expect(page.getByText("Internal Server Error")).toBeVisible({
        timeout: 5000,
      });

      // Error fallback has a homepage link
      await page.getByText("Go to homepage").click();

      await expect(testId(page, "index-page")).toBeVisible({
        timeout: 5000,
      });
    });

    test("should work with back navigation after error", async ({ page }) => {
      await page.goto(f.url("/errors"));
      await waitForHydration(page);

      await testId(page, "server-error-link").click();

      await expect(page.getByText("Internal Server Error")).toBeVisible({
        timeout: 5000,
      });

      await goBack(page);

      await expect(testId(page, "errors-title")).toBeVisible({
        timeout: 5000,
      });
    });

    test("server error preserves layout, client error replaces it", async ({
      page,
    }) => {
      // Server error: layout (nav) is preserved because the error is
      // caught per-segment during RSC render, not by the client-side
      // RootErrorBoundary which would replace the whole tree.
      await page.goto(f.url("/errors/server-error"));
      await expect(page.getByText("Internal Server Error")).toBeVisible({
        timeout: 5000,
      });
      // Nav is still visible — server errors are scoped to the errored segment
      await expect(testId(page, "nav")).toBeVisible();

      // Client error: RootErrorBoundary catches and replaces the entire tree
      await page.goto(f.url("/errors/client-error"));
      await waitForHydration(page);
      await testId(page, "client-error-thrower-trigger").click();
      await expect(page.getByText("Internal Server Error")).toBeVisible({
        timeout: 5000,
      });
      // Nav is gone — client errors bubble to RootErrorBoundary
      await expect(testId(page, "nav")).not.toBeVisible();

      // Recovery: navigate home and verify full app shell restored
      await page.getByText("Go to homepage").click();
      await waitForHydration(page);
      await expect(testId(page, "app-root")).toBeVisible();
      await expect(testId(page, "nav")).toBeVisible();
      await expect(testId(page, "index-page")).toBeVisible();
    });
  });
}

/**
 * Error boundary tests - dev mode
 */
test.describe("error-boundary", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });

  errorBoundaryTests(f, true);
});

/**
 * Error boundary tests - production mode
 */
test.describe("error-boundary (production)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "build",
  });

  test.setTimeout(120000);

  errorBoundaryTests(f, false);
});
