import { expect, test } from "@playwright/test";
import { useFixture, type Fixture } from "./fixture";
import { expectNoPageError, testId, waitForHydration } from "./helper";

/**
 * Build-time directive transforms (use-cache/server-action/use-client) plus
 * Static/Prerender/Link, exercised on the Cloudflare/workerd target. The dev
 * server applies these per-module; production bundling/minify/NODE_ENV-fold can
 * transform them differently, so the shared body runs in both dev and
 * production (mode: "build"). Describe titles stay literal so the e2e bucketing
 * guard routes the "(production)" suite to the production project.
 */
function transformCasesTests(f: Fixture) {
  test("renders transform static route", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/transform-cases"));
    await waitForHydration(page);

    await expect(testId(page, "cf-transform-static")).toBeVisible();
  });

  test("navigates to linked state route without errors", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/transform-cases"));
    await waitForHydration(page);

    await testId(page, "cf-transform-state-link").click();
    await expect(page).toHaveURL(/\/transform-cases\/state/);
    await expect(testId(page, "cf-transform-state-page")).toBeVisible();
  });

  test("renders prerender handler route", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/transform-cases/prerendered"));
    await waitForHydration(page);

    await expect(testId(page, "cf-transform-prerender-page")).toBeVisible();
  });
}

test.describe("transform-cases", () => {
  const f = useFixture({
    root: ".",
    mode: "dev",
  });
  transformCasesTests(f);
});

test.describe("transform-cases (production)", () => {
  const f = useFixture({
    root: ".",
    mode: "build",
  });
  transformCasesTests(f);
});
