import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError } from "./helper";

/**
 * Composition tests - verify globally imported helpers work
 * for reusable composition patterns.
 */
test.describe("composition-routes", () => {
  const f = useFixture({
    root: ".",
    mode: "dev",
  });

  test("should render composition index page", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/composition"));
    await waitForHydration(page);

    await expect(page.locator('[data-testid="composition-index"]')).toBeVisible(
      { timeout: 10000 },
    );
    await expect(page.locator("h1:has-text('Composition Test')")).toBeVisible();
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
