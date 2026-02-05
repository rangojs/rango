import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError, testId } from "./helper";

/**
 * Tests for ref serialization:
 * Loader and handle refs can be passed as props from server to client components.
 * RSC Flight protocol uses toJSON to serialize refs, and the client recovers
 * the collect function (for handles) from the module-level registry.
 */

test.describe("ref-serialization", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });

  test.setTimeout(30000);

  test.describe("loader-ref-as-prop", () => {
    test("SSR: should render loader data from prop-passed ref", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/ref-test/loader-prop"));
      await waitForHydration(page);

      // Loader data should be rendered
      await expect(testId(page, "ref-test-loader-page")).toBeVisible();
      await expect(testId(page, "ref-test-loader-message")).toContainText(
        "Slow data loaded",
      );
      await expect(testId(page, "ref-test-loader-count")).toContainText(
        "Load count:",
      );
      await expect(testId(page, "ref-test-loader-loaded-at")).toContainText(
        "Loaded:",
      );
    });

    test("SPA: should render loader data after navigation", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      // Start from index
      await page.goto(f.url("/"));
      await waitForHydration(page);

      // Navigate to loader-prop route via URL bar (SPA navigation)
      await page.evaluate(() => {
        window.history.pushState(null, "", "/ref-test/loader-prop");
        window.dispatchEvent(new PopStateEvent("popstate"));
      });

      // Wait for loader data to appear
      await expect(testId(page, "ref-test-loader-page")).toBeVisible({
        timeout: 10000,
      });
      await expect(testId(page, "ref-test-loader-message")).toContainText(
        "Slow data loaded",
      );
    });

    test("revalidation: should reload loader data via prop-passed ref", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/ref-test/loader-prop"));
      await waitForHydration(page);

      // Get initial count
      const initialCount = await testId(
        page,
        "ref-test-loader-count",
      ).textContent();

      // Click revalidate button
      await testId(page, "ref-test-loader-revalidate-btn").click();

      // Wait for count to change
      await expect
        .poll(
          async () =>
            await testId(page, "ref-test-loader-count").textContent(),
          { timeout: 10000 },
        )
        .not.toBe(initialCount);
    });
  });

  test.describe("handle-ref-as-prop", () => {
    test("SSR: should render handle data from prop-passed ref", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/ref-test/handle-prop"));
      await waitForHydration(page);

      // Handle data should be rendered
      await expect(testId(page, "ref-test-handle-page")).toBeVisible();
      await expect(testId(page, "ref-test-handle-list")).toBeVisible();

      // Root layout pushes "Home", route pushes "Home" + "Ref Test" = 3 items
      await expect(testId(page, "ref-test-handle-item-0")).toContainText(
        "Home",
      );
      // Last item should be "Ref Test" (from route handler)
      const items = page.locator('[data-testid^="ref-test-handle-item-"]');
      const lastItem = items.last();
      await expect(lastItem).toContainText("Ref Test");
    });

    test("SPA: should render handle data after navigation", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      // Start from index
      await page.goto(f.url("/"));
      await waitForHydration(page);

      // Navigate via URL bar
      await page.evaluate(() => {
        window.history.pushState(null, "", "/ref-test/handle-prop");
        window.dispatchEvent(new PopStateEvent("popstate"));
      });

      // Wait for handle data to appear
      await expect(testId(page, "ref-test-handle-page")).toBeVisible({
        timeout: 10000,
      });
      await expect(testId(page, "ref-test-handle-item-0")).toContainText(
        "Home",
      );
      const items = page.locator('[data-testid^="ref-test-handle-item-"]');
      const lastItem = items.last();
      await expect(lastItem).toContainText("Ref Test");
    });
  });

  test.describe("both-refs-as-props", () => {
    test("SSR: should render both loader and handle data", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/ref-test/both-props"));
      await waitForHydration(page);

      // Both components should be rendered
      await expect(testId(page, "ref-test-both-page")).toBeVisible();

      // Loader data
      await expect(testId(page, "ref-test-loader-message")).toContainText(
        "Slow data loaded",
      );

      // Handle data - root layout pushes "Home", route pushes "Home" + "Both Props"
      await expect(testId(page, "ref-test-handle-item-0")).toContainText(
        "Home",
      );
      const items = page.locator('[data-testid^="ref-test-handle-item-"]');
      const lastItem = items.last();
      await expect(lastItem).toContainText("Both Props");
    });

    test("SPA: should render both refs after navigation", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      // Start from index
      await page.goto(f.url("/"));
      await waitForHydration(page);

      // Navigate via URL bar
      await page.evaluate(() => {
        window.history.pushState(null, "", "/ref-test/both-props");
        window.dispatchEvent(new PopStateEvent("popstate"));
      });

      // Wait for both components to appear
      await expect(testId(page, "ref-test-both-page")).toBeVisible({
        timeout: 10000,
      });
      await expect(testId(page, "ref-test-loader-message")).toContainText(
        "Slow data loaded",
      );
      await expect(testId(page, "ref-test-handle-item-0")).toContainText(
        "Home",
      );
    });
  });
});

/**
 * Production tests - verify ref serialization works in production builds.
 */
test.describe("ref-serialization (production)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "build",
  });

  test.setTimeout(60000);

  test("SSR: loader ref as prop renders correctly", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/ref-test/loader-prop"));
    await waitForHydration(page);

    await expect(testId(page, "ref-test-loader-page")).toBeVisible();
    await expect(testId(page, "ref-test-loader-message")).toContainText(
      "Slow data loaded",
    );
  });

  test("SSR: handle ref as prop renders correctly", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/ref-test/handle-prop"));
    await waitForHydration(page);

    await expect(testId(page, "ref-test-handle-page")).toBeVisible();
    await expect(testId(page, "ref-test-handle-item-0")).toContainText("Home");
    const items = page.locator('[data-testid^="ref-test-handle-item-"]');
    const lastItem = items.last();
    await expect(lastItem).toContainText("Ref Test");
  });

  test("SSR: both refs as props render correctly", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/ref-test/both-props"));
    await waitForHydration(page);

    await expect(testId(page, "ref-test-both-page")).toBeVisible();
    await expect(testId(page, "ref-test-loader-message")).toContainText(
      "Slow data loaded",
    );
    await expect(testId(page, "ref-test-handle-item-0")).toContainText("Home");
  });
});
