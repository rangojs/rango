import { expect, test } from "@playwright/test";
import { test as devTest, devURL } from "./dev-fixture";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError } from "./helper";

/**
 * Composition tests (dev mode) - verify globally imported helpers work
 * for reusable composition patterns.
 */
devTest.describe("composition-routes", () => {
  devTest(
    "should render composition index page",
    async ({ page, devServerURL }) => {
      using _ = expectNoPageError(page);

      await page.goto(devURL(devServerURL, "/composition"));
      await waitForHydration(page);

      await expect(
        page.locator('[data-testid="composition-index"]'),
      ).toBeVisible({ timeout: 10000 });
      await expect(
        page.locator("h1:has-text('Composition Test')"),
      ).toBeVisible();
    },
  );

  devTest(
    "should render composition detail page",
    async ({ page, devServerURL }) => {
      using _ = expectNoPageError(page);

      await page.goto(devURL(devServerURL, "/composition/detail"));
      await waitForHydration(page);

      await expect(
        page.locator('[data-testid="composition-detail"]'),
      ).toBeVisible({ timeout: 10000 });
      await expect(
        page.locator("h1:has-text('Composition Detail')"),
      ).toBeVisible();
    },
  );
});

/**
 * Composition tests (production build)
 */
test.describe("composition-routes-build", () => {
  const f = useFixture({
    root: ".",
    mode: "build",
  });

  test("should render composition index page in production", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/composition"));
    await waitForHydration(page);

    await expect(page.locator('[data-testid="composition-index"]')).toBeVisible(
      { timeout: 10000 },
    );
  });

  test("should render composition detail page in production", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/composition/detail"));
    await waitForHydration(page);

    await expect(
      page.locator('[data-testid="composition-detail"]'),
    ).toBeVisible({ timeout: 10000 });
  });
});
