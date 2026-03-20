import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, testId } from "./helper";

/**
 * Regression test: handles (breadcrumbs, meta) must survive the sequence
 *   / → /blog → popstate(/) → /blog
 *
 * Bug: on the second forward navigation the cached handle data for /blog
 * was overwritten with /'s handle data during tx.commit(), so breadcrumbs
 * and other handles showed stale data from the previous route.
 */

function handlePopstateRegressionTests(mode: "dev" | "build") {
  const label = mode === "build" ? "production" : mode;
  test.describe(`handle-popstate-regression (${label})`, () => {
    const f = useFixture({
      root: "./e2e/test-app",
      mode,
    });

    test("breadcrumbs update after popstate + re-navigate to same route", async ({
      page,
    }) => {
      // 1. Start at the breadcrumb trail index (Home > Trail)
      await page.goto(f.url("/breadcrumb-trail"));
      await waitForHydration(page);

      const nav = page.locator('nav[aria-label="Trail"]');

      // Verify initial breadcrumbs: Home > Trail
      await expect(nav.locator("a")).toHaveCount(1);
      await expect(nav.locator("a").first()).toHaveText("Home");
      await expect(nav.locator('[aria-current="page"]')).toHaveText("Trail");

      // 2. Navigate to /breadcrumb-trail/docs (Home > Trail > Docs)
      await testId(page, "trail-link-docs").click();
      await expect(testId(page, "trail-docs-page")).toBeVisible({
        timeout: 5000,
      });

      await expect(nav.locator("a")).toHaveCount(2);
      await expect(nav.locator('[aria-current="page"]')).toHaveText("Docs");

      // 3. Popstate back to /breadcrumb-trail (Home > Trail)
      await page.goBack();
      await expect(testId(page, "trail-index-page")).toBeVisible({
        timeout: 5000,
      });

      await expect(nav.locator("a")).toHaveCount(1);
      await expect(nav.locator('[aria-current="page"]')).toHaveText("Trail");

      // 4. Navigate to /breadcrumb-trail/docs AGAIN — this is where the bug hits
      await testId(page, "trail-link-docs").click();
      await expect(testId(page, "trail-docs-page")).toBeVisible({
        timeout: 5000,
      });

      // REGRESSION: breadcrumbs must show Home > Trail > Docs (3 items, 2 links)
      // Bug: they were stuck on Home > Trail (2 items) from the popstate cache
      await expect(nav.locator("a")).toHaveCount(2, { timeout: 5000 });
      await expect(nav.locator('[aria-current="page"]')).toHaveText("Docs");
    });

    test("breadcrumbs update after popstate + re-navigate (deep route)", async ({
      page,
    }) => {
      // 1. Start at /breadcrumb-trail
      await page.goto(f.url("/breadcrumb-trail"));
      await waitForHydration(page);

      const nav = page.locator('nav[aria-label="Trail"]');

      // 2. Navigate to /breadcrumb-trail/docs/getting-started (Home > Trail > Docs > Getting Started)
      await testId(page, "trail-link-getting-started").click();
      await expect(testId(page, "trail-guide-page")).toBeVisible({
        timeout: 5000,
      });

      await expect(nav.locator("a")).toHaveCount(3, { timeout: 5000 });
      await expect(nav.locator('[aria-current="page"]')).toHaveText(
        "Getting Started",
      );

      // 3. Popstate back to /breadcrumb-trail (Home > Trail)
      await page.goBack();
      await expect(testId(page, "trail-index-page")).toBeVisible({
        timeout: 5000,
      });

      await expect(nav.locator("a")).toHaveCount(1);
      await expect(nav.locator('[aria-current="page"]')).toHaveText("Trail");

      // 4. Navigate to /breadcrumb-trail/docs/getting-started AGAIN
      await testId(page, "trail-link-getting-started").click();
      await expect(testId(page, "trail-guide-page")).toBeVisible({
        timeout: 5000,
      });

      // REGRESSION: must show 4 breadcrumb items (3 links + 1 current)
      await expect(nav.locator("a")).toHaveCount(3, { timeout: 5000 });
      await expect(nav.locator('[aria-current="page"]')).toHaveText(
        "Getting Started",
      );
    });

    test("breadcrumbs survive multiple popstate + re-navigate cycles", async ({
      page,
    }) => {
      await page.goto(f.url("/breadcrumb-trail"));
      await waitForHydration(page);

      const nav = page.locator('nav[aria-label="Trail"]');

      // Cycle 3 times: navigate to docs → back → navigate to docs
      for (let i = 0; i < 3; i++) {
        // Navigate to docs
        await testId(page, "trail-link-docs").click();
        await expect(testId(page, "trail-docs-page")).toBeVisible({
          timeout: 5000,
        });

        await expect(nav.locator("a")).toHaveCount(2, { timeout: 5000 });
        await expect(nav.locator('[aria-current="page"]')).toHaveText("Docs");

        // Go back
        await page.goBack();
        await expect(testId(page, "trail-index-page")).toBeVisible({
          timeout: 5000,
        });

        await expect(nav.locator("a")).toHaveCount(1);
        await expect(nav.locator('[aria-current="page"]')).toHaveText("Trail");
      }

      // Final navigation should still work
      await testId(page, "trail-link-docs").click();
      await expect(testId(page, "trail-docs-page")).toBeVisible({
        timeout: 5000,
      });

      await expect(nav.locator("a")).toHaveCount(2, { timeout: 5000 });
      await expect(nav.locator('[aria-current="page"]')).toHaveText("Docs");
    });
  });
}

// Run in both dev and production modes
handlePopstateRegressionTests("dev");
handlePopstateRegressionTests("build");
