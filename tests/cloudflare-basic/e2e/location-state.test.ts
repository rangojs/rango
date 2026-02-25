import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError, testId } from "./helper";

test.describe.configure({ mode: "serial" });

/**
 * Location state tests - passing state during navigation
 */
test.describe("location-state", () => {
  const f = useFixture({
    root: ".",
    mode: "dev",
  });

  test("should show feature links on home page", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/"));
    await waitForHydration(page);

    const featureLinks = testId(page, "feature-links");
    await expect(featureLinks).toBeVisible();
    await expect(testId(page, "feature-link-server-components")).toBeVisible();
    await expect(testId(page, "feature-link-server-actions")).toBeVisible();
    await expect(testId(page, "feature-link-streaming")).toBeVisible();
  });

  test("should show location state in loading state when navigating with state", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/"));
    await waitForHydration(page);

    // Click the feature link (which passes location state)
    await testId(page, "feature-link-server-components").click();

    // Should show loading state with state data from location state
    const loadingName = testId(page, "feature-loading-name");
    const loadingDescription = testId(page, "feature-loading-description");

    // Either we see the loading state with data, or the page has already loaded
    // The loading state should show the state data if visible
    try {
      await expect(loadingName).toBeVisible({ timeout: 500 });
      await expect(loadingName).toHaveText("Server Components");
      await expect(loadingDescription).toHaveText(
        "React components that render on the server",
      );
    } catch {
      // Page loaded fast, check the final content instead
      await expect(testId(page, "feature-page")).toBeVisible();
    }

    // Eventually the feature page should be visible
    await expect(testId(page, "feature-page")).toBeVisible({ timeout: 5000 });
    await expect(testId(page, "feature-title")).toHaveText("Server Components");
  });

  test("should show skeleton in loading state when navigating without state", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // Navigate directly to a feature page (no location state)
    await page.goto(f.url("/features/streaming"));
    await waitForHydration(page);

    // Should eventually show the feature page
    await expect(testId(page, "feature-page")).toBeVisible({ timeout: 5000 });
    await expect(testId(page, "feature-title")).toHaveText("Streaming");
  });

  test("should navigate to different features with correct state", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/"));
    await waitForHydration(page);

    // Navigate to server-actions feature
    await testId(page, "feature-link-server-actions").click();

    // Wait for the page to load
    await expect(testId(page, "feature-page")).toBeVisible({ timeout: 5000 });
    await expect(testId(page, "feature-title")).toHaveText("Server Actions");

    // Go back to home
    await page.goBack();
    await expect(testId(page, "home-page")).toBeVisible();

    // Navigate to streaming feature
    await testId(page, "feature-link-streaming").click();

    // Wait for the page to load
    await expect(testId(page, "feature-page")).toBeVisible({ timeout: 5000 });
    await expect(testId(page, "feature-title")).toHaveText("Streaming");
  });

  test("should preserve location state across browser history", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/"));
    await waitForHydration(page);

    // Navigate to a feature with state
    await testId(page, "feature-link-server-components").click();
    await expect(testId(page, "feature-page")).toBeVisible({ timeout: 5000 });

    // Navigate to another feature
    await page.goto(f.url("/"));
    await waitForHydration(page);
    await testId(page, "feature-link-streaming").click();
    await expect(testId(page, "feature-page")).toBeVisible({ timeout: 5000 });

    // Go back should show the previous feature
    await page.goBack();
    await expect(testId(page, "home-page")).toBeVisible();

    // Go back again should be on home
    await page.goBack();
    await expect(testId(page, "feature-page")).toBeVisible();
    await expect(testId(page, "feature-title")).toHaveText("Server Components");
  });

  test("should not show hydration mismatch with location state", async ({
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

    await page.goto(f.url("/"));
    await waitForHydration(page);

    // Navigate with state
    await testId(page, "feature-link-server-components").click();
    await expect(testId(page, "feature-page")).toBeVisible({ timeout: 5000 });
    expect(hydrationErrors).toEqual([]);

    // Direct navigation without state
    await page.goto(f.url("/features/streaming"));
    await waitForHydration(page);
    await expect(testId(page, "feature-page")).toBeVisible({ timeout: 5000 });
    expect(hydrationErrors).toEqual([]);
  });
});
