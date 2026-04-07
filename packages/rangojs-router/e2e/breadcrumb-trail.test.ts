import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, testId } from "./helper";

/**
 * Tests for the built-in <BreadcrumbTrail /> component.
 *
 * These routes are nested inside RootLayout which pushes "Home" (href="/"),
 * so all breadcrumb trails start with "Home". The TrailLayout then pushes
 * "Trail" (href="/breadcrumb-trail") and child routes push their own items.
 *
 * Covers: accessible markup (nav, aria-label, aria-current, aria-hidden),
 * custom separator, <a> links for non-current items, async content with
 * Suspense, soft navigation updates, and no hydration mismatches.
 */

function breadcrumbTrailTests(mode: "dev" | "build") {
  const label = mode === "build" ? "production" : mode;
  test.describe(`breadcrumb-trail (${label})`, () => {
    const f = useFixture({
      root: "./e2e/test-app",
      mode,
    });

    test("should render accessible nav with aria-label", async ({ page }) => {
      await page.goto(f.url("/breadcrumb-trail"));
      await waitForHydration(page);

      const nav = page.locator('nav[aria-label="Trail"]');
      await expect(nav).toBeVisible();
      await expect(nav.locator("ol")).toBeVisible();
    });

    test("should render current page with aria-current='page'", async ({
      page,
    }) => {
      await page.goto(f.url("/breadcrumb-trail"));
      await waitForHydration(page);

      const nav = page.locator('nav[aria-label="Trail"]');
      // Home(/) > Trail(/breadcrumb-trail) — Trail is current
      const current = nav.locator('[aria-current="page"]');
      await expect(current).toHaveText("Trail");
    });

    test("should render custom separator with aria-hidden", async ({
      page,
    }) => {
      await page.goto(f.url("/breadcrumb-trail/docs"));
      await waitForHydration(page);

      const nav = page.locator('nav[aria-label="Trail"]');
      // Home > Trail > Docs — two separators
      const separators = nav.locator('[aria-hidden="true"]');
      await expect(separators).toHaveCount(2);
      await expect(separators.first()).toHaveText("›");
    });

    test("should render non-current items as <a> links", async ({ page }) => {
      await page.goto(f.url("/breadcrumb-trail/docs"));
      await waitForHydration(page);

      const nav = page.locator('nav[aria-label="Trail"]');

      // Home and Trail are links
      const links = nav.locator("a");
      await expect(links).toHaveCount(2);
      await expect(links.nth(0)).toHaveText("Home");
      await expect(links.nth(1)).toHaveText("Trail");

      // Docs is current (not a link)
      const current = nav.locator('[aria-current="page"]');
      await expect(current).toHaveText("Docs");
    });

    test("should render four-level breadcrumbs with correct structure", async ({
      page,
    }) => {
      await page.goto(f.url("/breadcrumb-trail/docs/getting-started"));
      await waitForHydration(page);

      const nav = page.locator('nav[aria-label="Trail"]');

      // Three links (Home, Trail, Docs) + one current (Getting Started)
      const links = nav.locator("a");
      await expect(links).toHaveCount(3);
      await expect(links.nth(0)).toHaveText("Home");
      await expect(links.nth(1)).toHaveText("Trail");
      await expect(links.nth(2)).toHaveText("Docs");

      const current = nav.locator('[aria-current="page"]');
      await expect(current).toHaveText("Getting Started");

      // Three separators
      const separators = nav.locator('[aria-hidden="true"]');
      await expect(separators).toHaveCount(3);
    });

    test("should stream async content", async ({ page }) => {
      await page.goto(f.url("/breadcrumb-trail/docs/getting-started"));
      await waitForHydration(page);

      // Scope to trail nav to avoid strict mode violation (BreadcrumbNav also renders it)
      const nav = page.locator('nav[aria-label="Trail"]');
      const asyncContent = nav.locator('[data-testid="trail-async-content"]');
      await expect(asyncContent).toBeVisible({ timeout: 5000 });
      await expect(asyncContent).toHaveText("v2.0");
    });

    test("should update on soft navigation", async ({ page }) => {
      await page.goto(f.url("/breadcrumb-trail"));
      await waitForHydration(page);

      const nav = page.locator('nav[aria-label="Trail"]');

      // Home(/) > Trail(/breadcrumb-trail) — 1 link, 1 current
      await expect(nav.locator('[aria-current="page"]')).toHaveText("Trail");
      await expect(nav.locator("a")).toHaveCount(1);

      // Soft navigate to /docs
      await testId(page, "trail-link-docs").click();
      await expect(testId(page, "trail-docs-page")).toBeVisible({
        timeout: 5000,
      });

      // Home > Trail > Docs — 2 links, 1 current
      await expect(nav.locator("a")).toHaveCount(2);
      await expect(nav.locator('[aria-current="page"]')).toHaveText("Docs");
    });

    test("should update on back navigation", async ({ page }) => {
      // Use a fresh hard navigation to /breadcrumb-trail/docs/getting-started
      // to avoid the Vite error overlay race from delayed-breadcrumbs route
      await page.goto(f.url("/breadcrumb-trail/docs/getting-started"));
      await waitForHydration(page);

      const nav = page.locator('nav[aria-label="Trail"]');

      // Home > Trail > Docs > Getting Started — 3 links
      await expect(nav.locator("a")).toHaveCount(3);

      // Navigate back to docs
      await testId(page, "trail-back-to-docs").click();
      await expect(testId(page, "trail-docs-page")).toBeVisible({
        timeout: 5000,
      });

      // Home > Trail > Docs — 2 links
      await expect(nav.locator("a")).toHaveCount(2);
      await expect(nav.locator('[aria-current="page"]')).toHaveText("Docs");
    });

    test("should not produce hydration mismatches", async ({ page }) => {
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

      await page.goto(f.url("/breadcrumb-trail"));
      await waitForHydration(page);
      expect(hydrationErrors).toEqual([]);

      await page.goto(f.url("/breadcrumb-trail/docs"));
      await waitForHydration(page);
      expect(hydrationErrors).toEqual([]);

      await page.goto(f.url("/breadcrumb-trail/docs/getting-started"));
      await waitForHydration(page);
      expect(hydrationErrors).toEqual([]);
    });
  });
}

// Run all tests in both dev and production modes
breadcrumbTrailTests("dev");
breadcrumbTrailTests("build");
