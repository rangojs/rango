import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { expectNoPageError, testId, waitForHydration } from "./helper";

test.describe("transform-cases", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });

  test("renders transform static route", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/transform-cases"));
    await waitForHydration(page);

    await expect(testId(page, "transform-cases-static")).toBeVisible();
  });

  test("navigates to linked state route without errors", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/transform-cases"));
    await waitForHydration(page);

    await testId(page, "transform-cases-state-link").click();
    await expect(page).toHaveURL(/\/transform-cases\/state/);
    await expect(testId(page, "transform-cases-state-page")).toBeVisible();
  });

  test("renders prerender handler route", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/transform-cases/prerendered"));
    await waitForHydration(page);

    await expect(testId(page, "transform-cases-prerender-page")).toBeVisible();
  });
});
