import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, testId } from "./helper";

/**
 * Not found (404) tests - verifying proper 404 handling when no route matches (dev)
 */
test.describe("not-found", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });

  test.describe("direct-navigation-to-unknown-route", () => {
    test("should return 404 status for unknown route", async ({ page }) => {
      const response = await page.goto(f.url("/this-page-does-not-exist"));

      // Should return 404 status, not 500
      expect(response?.status()).toBe(404);
    });

    test("should render Not Found heading", async ({ page }) => {
      await page.goto(f.url("/unknown-route"));

      // Should show "Not Found" heading (no hydration needed for simple 404)
      await expect(
        page.getByRole("heading", { name: "Not Found" })
      ).toBeVisible({ timeout: 5000 });
    });
  });

  test.describe("404-vs-500-distinction", () => {
    test("should return 404 not 500 for unknown routes", async ({ page }) => {
      // This is the key test - unknown routes should be 404, not 500
      const response = await page.goto(f.url("/definitely-not-a-route"));

      // Must be 404
      expect(response?.status()).toBe(404);

      // Should NOT be 500 (server error)
      expect(response?.status()).not.toBe(500);
    });

    test("should return 404 for various unknown paths", async ({ page }) => {
      const unknownPaths = [
        "/unknown",
        "/foo/bar/baz",
        "/admin/secret",
        "/api/v1/unknown",
      ];

      for (const path of unknownPaths) {
        const response = await page.goto(f.url(path));
        expect(response?.status()).toBe(404);
      }
    });
  });

  test.describe("navigation-from-404", () => {
    test("should be able to navigate away from 404 page", async ({ page }) => {
      // Navigate to 404 page
      await page.goto(f.url("/unknown-page"));

      // Verify we're on 404 (no hydration needed - 404 is server-rendered)
      await expect(
        page.getByRole("heading", { name: "Not Found" })
      ).toBeVisible({ timeout: 5000 });

      // Navigate away from 404 to home (direct navigation)
      await page.goto(f.url("/"));

      // Should successfully navigate to home
      await expect(testId(page, "index-page")).toBeVisible({ timeout: 5000 });
    });

    test("should handle back navigation after 404", async ({ page }) => {
      // Start at home
      await page.goto(f.url("/"));
      await waitForHydration(page);

      // Navigate to 404 page via direct navigation
      await page.goto(f.url("/unknown-page"));

      // Verify we're on 404 (no hydration needed - 404 is server-rendered)
      await expect(
        page.getByRole("heading", { name: "Not Found" })
      ).toBeVisible({ timeout: 5000 });

      // Go back
      await page.goBack();

      // Should be back at home
      await expect(testId(page, "index-page")).toBeVisible({ timeout: 5000 });
    });
  });
});

/**
 * Not found (404) tests - production build
 */
test.describe("not-found (production)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "build",
  });

  test("should return 404 status for unknown route", async ({ page }) => {
    const response = await page.goto(f.url("/this-page-does-not-exist"));

    // Should return 404 status, not 500
    expect(response?.status()).toBe(404);
  });

  test("should render Not Found heading", async ({ page }) => {
    await page.goto(f.url("/unknown-route"));

    // Should show "Not Found" heading (no hydration needed for simple 404)
    await expect(
      page.getByRole("heading", { name: "Not Found" })
    ).toBeVisible({ timeout: 5000 });
  });

  test("should return 404 for various unknown paths", async ({ page }) => {
    const unknownPaths = [
      "/unknown",
      "/foo/bar/baz",
      "/admin/secret",
    ];

    for (const path of unknownPaths) {
      const response = await page.goto(f.url(path));
      expect(response?.status()).toBe(404);
    }
  });
});
