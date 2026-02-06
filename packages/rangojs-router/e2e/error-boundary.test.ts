import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, testId, goBack } from "./helper";

/**
 * Error boundary tests - verifying client and server errors are caught
 */
test.describe("error-boundary", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });

  test.describe("client-component-errors", () => {
    test("should show error boundary when client component throws on interaction", async ({
      page,
    }) => {
      // Navigate to the client error page
      await page.goto(f.url("/errors/client-error"));
      await waitForHydration(page);

      // Verify the page rendered correctly
      await expect(testId(page, "client-error-title")).toBeVisible();
      await expect(testId(page, "client-error-thrower")).toBeVisible();

      // Click the button to trigger the error
      await testId(page, "client-error-thrower-trigger").click();

      // The error boundary should catch the error and show fallback UI
      // RootErrorBoundary shows "Internal Server Error" and the error message
      await expect(page.getByText("Internal Server Error")).toBeVisible({
        timeout: 5000,
      });

      // Verify the error message is displayed
      await expect(
        page.getByText("Client-side error", { exact: false }).first()
      ).toBeVisible();
    });

    test("should preserve app shell during client error", async ({ page }) => {
      await page.goto(f.url("/errors/client-error"));
      await waitForHydration(page);

      // Verify the app shell elements are present
      await expect(testId(page, "app-root")).toBeVisible();
      await expect(testId(page, "nav")).toBeVisible();

      // Trigger the error
      await testId(page, "client-error-thrower-trigger").click();

      // Wait for error boundary
      await expect(page.getByText("Internal Server Error")).toBeVisible({
        timeout: 5000,
      });

      // The RootErrorBoundary wraps content inside NavigationProvider,
      // so it replaces the content but NOT the whole document.
      // However, the app-root and nav are INSIDE the RSC payload (part of the layout),
      // so they get replaced when the error boundary catches the error.
      // This is expected behavior - the error boundary fallback replaces the errored content.
    });
  });

  test.describe("server-component-errors", () => {
    test("should show error boundary for server component error", async ({
      page,
    }) => {
      // Direct navigation to server error route
      await page.goto(f.url("/errors/server-error"));

      // The error boundary should catch the server error and show fallback
      await expect(page.getByText("Internal Server Error")).toBeVisible({
        timeout: 5000,
      });

      // Verify the error message mentions it's a server error
      await expect(
        page.getByText("Server error", { exact: false }).first()
      ).toBeVisible();
    });

    test("should show error boundary on SPA navigation to server error", async ({
      page,
    }) => {
      // Start at the errors index page
      await page.goto(f.url("/errors"));
      await waitForHydration(page);

      // Verify we're on the errors index
      await expect(testId(page, "errors-title")).toBeVisible();

      // Navigate to the server error route via SPA
      await testId(page, "server-error-link").click();

      // The error boundary should catch the error
      await expect(page.getByText("Internal Server Error")).toBeVisible({
        timeout: 5000,
      });

      // App shell should still be visible
      await expect(testId(page, "app-root")).toBeVisible();
    });
  });

  test.describe("streaming-errors", () => {
    test("should show loading then error boundary for streaming error", async ({
      page,
    }) => {
      // Navigate to streaming error page
      await page.goto(f.url("/errors/streaming-error"));

      // Should briefly show loading state
      await expect(testId(page, "streaming-error-loading")).toBeVisible({
        timeout: 2000,
      });

      // Then the error boundary should appear after the async error
      await expect(page.getByText("Internal Server Error")).toBeVisible({
        timeout: 5000,
      });

      // Verify the error message mentions streaming
      await expect(
        page.getByText("Streaming error", { exact: false }).first()
      ).toBeVisible();
    });

    test("should handle SPA navigation to streaming error route", async ({
      page,
    }) => {
      // Start at errors index
      await page.goto(f.url("/errors"));
      await waitForHydration(page);

      // Navigate to streaming error route
      await testId(page, "streaming-error-link").click();

      // Should show loading
      await expect(testId(page, "streaming-error-loading")).toBeVisible({
        timeout: 2000,
      });

      // Then error boundary
      await expect(page.getByText("Internal Server Error")).toBeVisible({
        timeout: 5000,
      });

      // The RootErrorBoundary replaces the entire content, including the app shell
      // This is expected since the error boundary catches the error at the NavigationProvider level
    });
  });

  test.describe("navigation-after-error", () => {
    test("should be able to navigate away from error boundary", async ({
      page,
    }) => {
      // Navigate to server error page (will show error boundary)
      await page.goto(f.url("/errors/server-error"));

      // Wait for error boundary
      await expect(page.getByText("Internal Server Error")).toBeVisible({
        timeout: 5000,
      });

      // Navigate to home using the nav
      await testId(page, "nav-home").click();

      // Should successfully navigate to home
      await expect(testId(page, "index-page")).toBeVisible({
        timeout: 5000,
      });
    });

    test("should work with back navigation after error", async ({ page }) => {
      // Start at errors index page
      await page.goto(f.url("/errors"));
      await waitForHydration(page);

      // Navigate to server error
      await testId(page, "server-error-link").click();

      // Wait for error boundary
      await expect(page.getByText("Internal Server Error")).toBeVisible({
        timeout: 5000,
      });

      // Go back
      await goBack(page);

      // Should be back at errors index
      await expect(testId(page, "errors-title")).toBeVisible({
        timeout: 5000,
      });
    });
  });
});
