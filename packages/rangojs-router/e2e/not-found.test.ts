import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, testId } from "./helper";

/**
 * Shared 404 tests run against both dev and production.
 *
 * Contract under test:
 * - Unknown routes return HTTP 404, never 500
 * - 404 page renders "Not Found" heading
 * - Various unknown path shapes all produce 404
 * - Direct navigation away from 404 works
 * - Back navigation from 404 returns to previous page
 * - Popstate to unknown route shows 404 content
 */
function notFoundTests(f: ReturnType<typeof useFixture>) {
  test.describe("notFound()-without-boundary", () => {
    test("should return 404 when handler throws notFound() without a notFoundBoundary", async ({
      page,
    }) => {
      const response = await page.goto(f.url("/not-found-no-boundary"));
      expect(response?.status()).toBe(404);
    });

    test("should render Not Found UI, not an error page", async ({ page }) => {
      await page.goto(f.url("/not-found-no-boundary"));

      // Should show a not-found page, not an error boundary
      await expect(
        page.getByRole("heading", { name: "Not Found" }),
      ).toBeVisible({ timeout: 5000 });

      // Should NOT show an error page
      await expect(
        page.locator("text=Internal Server Error"),
      ).not.toBeVisible();
    });
  });

  test.describe("direct-navigation-to-unknown-route", () => {
    test("should return 404 status for unknown route", async ({ page }) => {
      const response = await page.goto(f.url("/this-page-does-not-exist"));
      expect(response?.status()).toBe(404);
    });

    test("should render Not Found heading", async ({ page }) => {
      await page.goto(f.url("/unknown-route"));
      await expect(
        page.getByRole("heading", { name: "Not Found" }),
      ).toBeVisible({ timeout: 5000 });
    });
  });

  test.describe("404-vs-500-distinction", () => {
    test("should return 404 not 500 for unknown routes", async ({ page }) => {
      const response = await page.goto(f.url("/definitely-not-a-route"));
      expect(response?.status()).toBe(404);
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
      await page.goto(f.url("/unknown-page"));

      await expect(
        page.getByRole("heading", { name: "Not Found" }),
      ).toBeVisible({ timeout: 5000 });

      await page.goto(f.url("/"));

      await expect(testId(page, "index-page")).toBeVisible({ timeout: 5000 });
    });

    test("should handle back navigation after 404", async ({ page }) => {
      await page.goto(f.url("/"));
      await waitForHydration(page);

      await page.goto(f.url("/unknown-page"));

      await expect(
        page.getByRole("heading", { name: "Not Found" }),
      ).toBeVisible({ timeout: 5000 });

      await page.goBack();

      await expect(testId(page, "index-page")).toBeVisible({ timeout: 5000 });
    });
  });

  test.describe("popstate-to-unknown-route", () => {
    test("popstate to unknown route shows Not Found", async ({ page }) => {
      await page.goto(f.url("/"));
      await waitForHydration(page);

      // Simulate back/forward navigation to an unknown URL via popstate.
      // This tests the router's popstate handler, not a Link-based navigation.
      await page.evaluate(() => {
        window.history.pushState({}, "", "/does-not-exist-spa");
        window.dispatchEvent(new PopStateEvent("popstate"));
      });

      await expect(
        page.getByRole("heading", { name: "Not Found" }),
      ).toBeVisible({ timeout: 5000 });
    });
  });
}

test.describe("not-found", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });

  notFoundTests(f);
});

test.describe("not-found (production)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "build",
  });

  test.setTimeout(120000);

  notFoundTests(f);
});
