import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError } from "./helper";

/**
 * Composition tests - verify globally imported helpers work
 * for reusable composition patterns. Both pages render deterministic
 * content, so the assertions hold in dev and the production build alike.
 */
function describeComposition(mode: "dev" | "build") {
  const label = mode === "build" ? "production" : "dev";
  test.describe(`composition-routes (${label})`, () => {
    const f = useFixture({
      root: ".",
      mode,
    });

    test("should render composition index page", async ({ page }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/composition"));
      await waitForHydration(page);

      await expect(
        page.locator('[data-testid="composition-index"]'),
      ).toBeVisible({ timeout: 10000 });
      await expect(
        page.locator("h1:has-text('Composition Test')"),
      ).toBeVisible();
    });

    test("should render composition detail page", async ({ page }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/composition/detail"));
      await waitForHydration(page);

      await expect(
        page.locator('[data-testid="composition-detail"]'),
      ).toBeVisible({ timeout: 10000 });
      await expect(
        page.locator("h1:has-text('Composition Detail')"),
      ).toBeVisible();
    });
  });
}

describeComposition("dev");
describeComposition("build");
