import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { expectNoPageError, testId, waitForHydration } from "./helper";

test.describe("transform-cases", () => {
  const f = useFixture({
    root: ".",
    mode: "dev",
  });

  test("renders transform static route", async ({
    page,
  }) => {
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
});
