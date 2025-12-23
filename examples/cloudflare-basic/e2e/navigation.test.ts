import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import {
  waitForHydration,
  expectNoPageError,
  goBack,
  testId,
  expectNoReload,
} from "./helper";

// Run tests in both dev and build/preview modes
for (const mode of ["dev", "build"] as const) {
  test.describe(`navigation (${mode})`, () => {
    test.describe.configure({ mode: "serial" });

    const f = useFixture({
      root: ".",
      mode,
    });

    test("should render home page on initial load", async ({ page }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/"));
      await waitForHydration(page);

      await expect(testId(page, "home-page")).toBeVisible();
      await expect(testId(page, "home-title")).toHaveText("Welcome to RSC Router");
      await expect(testId(page, "nav")).toBeVisible();
    });

    test("should navigate to about page via link", async ({ page }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/"));
      await waitForHydration(page);

      // Click about link
      await testId(page, "nav-about").click();

      // Should navigate to about page
      await expect(page).toHaveURL(/\/about/);
      await expect(testId(page, "about-page")).toBeVisible();
      await expect(testId(page, "about-title")).toHaveText("About");
    });

    test("should navigate to counter page via link", async ({ page }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/"));
      await waitForHydration(page);

      // Click counter link
      await testId(page, "nav-counter").click();

      // Should navigate to counter page
      await expect(page).toHaveURL(/\/counter/);
      await expect(testId(page, "counter-page")).toBeVisible();
      await expect(testId(page, "counter-title")).toHaveText("Counter Demo");
      await expect(testId(page, "counter")).toBeVisible();
    });

    test("should preserve nav during navigation (no page reload)", async ({ page }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/"));
      await waitForHydration(page);

      await using __ = await expectNoReload(page);

      // Navigate to about
      await testId(page, "nav-about").click();
      await expect(testId(page, "about-page")).toBeVisible();

      // Navigate to counter
      await testId(page, "nav-counter").click();
      await expect(testId(page, "counter-page")).toBeVisible();

      // Navigate back to home
      await testId(page, "nav-home").click();
      await expect(testId(page, "home-page")).toBeVisible();
    });

    test("should handle browser back/forward navigation", async ({ page }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/"));
      await waitForHydration(page);

      // Navigate to about
      await testId(page, "nav-about").click();
      await expect(testId(page, "about-page")).toBeVisible();

      // Navigate to counter
      await testId(page, "nav-counter").click();
      await expect(testId(page, "counter-page")).toBeVisible();

      // Go back to about
      await goBack(page);
      await expect(testId(page, "about-page")).toBeVisible();

      // Go back to home
      await goBack(page);
      await expect(testId(page, "home-page")).toBeVisible();
    });

    test("should render correct page on direct navigation", async ({ page }) => {
      using _ = expectNoPageError(page);

      // Navigate directly to about
      await page.goto(f.url("/about"));
      await waitForHydration(page);
      await expect(testId(page, "about-page")).toBeVisible();

      // Navigate directly to counter
      await page.goto(f.url("/counter"));
      await waitForHydration(page);
      await expect(testId(page, "counter-page")).toBeVisible();
    });
  });
}
