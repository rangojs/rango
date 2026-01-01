import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError, testId } from "./helper";

/**
 * Tests for useFetchLoader hook (GET-based loader fetching):
 * 1. Client can fetch loader data via GET request
 * 2. Loader $$id is correctly set by plugin
 * 3. Multiple fetches work (refetch functionality)
 * 4. Custom params are passed correctly
 * 5. Works in both dev and production builds
 */

test.describe("useFetchLoader", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });

  test.setTimeout(30000);

  test("should render fetch loader page", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/fetch-loader"));
    await waitForHydration(page);

    // Page should render
    await expect(testId(page, "fetch-loader-page")).toBeVisible();
    await expect(testId(page, "fetch-loader-title")).toContainText(
      "useFetchLoader Test"
    );

    // Component should render with buttons
    await expect(testId(page, "fetch-loader-test")).toBeVisible();
    await expect(testId(page, "fetch-loader-btn-default")).toBeVisible();
  });

  test("should fetch loader data with default params", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/fetch-loader"));
    await waitForHydration(page);

    // Click fetch button
    await testId(page, "fetch-loader-btn-default").click();

    // Should show loading state
    await expect(testId(page, "fetch-loader-loading")).toBeVisible({
      timeout: 500,
    });

    // Wait for data to appear
    await expect(testId(page, "fetch-loader-data")).toBeVisible({
      timeout: 5000,
    });

    // Verify fetched data
    await expect(testId(page, "fetch-loader-message")).toContainText(
      "Fetched via GET!"
    );
    await expect(testId(page, "fetch-loader-id")).toContainText("ID: default");
    await expect(testId(page, "fetch-loader-count")).toContainText("Count: 1");
  });

  test("should fetch loader data with custom params", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/fetch-loader"));
    await waitForHydration(page);

    // Click custom fetch button
    await testId(page, "fetch-loader-btn-custom").click();

    // Wait for data
    await expect(testId(page, "fetch-loader-data")).toBeVisible({
      timeout: 5000,
    });

    // Verify custom ID was passed
    await expect(testId(page, "fetch-loader-id")).toContainText(
      "ID: custom-123"
    );
  });

  test("should support refetching (multiple fetches)", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/fetch-loader"));
    await waitForHydration(page);

    // First fetch
    await testId(page, "fetch-loader-btn-default").click();
    await expect(testId(page, "fetch-loader-data")).toBeVisible({
      timeout: 5000,
    });

    // Get initial count
    const count1Text = await testId(page, "fetch-loader-count").textContent();
    const count1 = parseInt(count1Text?.match(/\d+/)?.[0] || "0");

    // Refetch with different ID
    await testId(page, "fetch-loader-btn-refetch").click();

    // Wait for ID to change (indicates new data has loaded)
    await expect(testId(page, "fetch-loader-id")).toContainText("ID: refetch", {
      timeout: 5000,
    });

    // Count should have incremented (wait for it to update)
    await expect(testId(page, "fetch-loader-count")).not.toHaveText(
      `Count: ${count1}`,
      { timeout: 5000 }
    );

    const count2Text = await testId(page, "fetch-loader-count").textContent();
    const count2 = parseInt(count2Text?.match(/\d+/)?.[0] || "0");
    expect(count2).toBeGreaterThan(count1);
  });
});

test.describe("useFetchLoader (production)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "build",
  });

  test.setTimeout(60000); // Build takes time

  // TODO: Add preview script to test-app for production testing
  test.skip("should work in production build", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/fetch-loader"));
    await waitForHydration(page);

    // Click fetch button
    await testId(page, "fetch-loader-btn-default").click();

    // Wait for data
    await expect(testId(page, "fetch-loader-data")).toBeVisible({
      timeout: 5000,
    });

    // Verify data is correct
    await expect(testId(page, "fetch-loader-message")).toContainText(
      "Fetched via GET!"
    );
  });
});
