import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import {
  waitForHydration,
  expectNoPageError,
  testId,
  expectNoReload,
} from "./helper";

test.describe.configure({ mode: "serial" });

test.describe("multi-router", () => {
  const f = useFixture({
    root: ".",
    mode: "dev",
  });

  test.describe("site app (localhost)", () => {
    test("should render home page", async ({ page }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/"));
      await waitForHydration(page);

      await expect(testId(page, "site-home-page")).toBeVisible();
      await expect(testId(page, "site-home-title")).toHaveText(
        "Welcome to the Site",
      );
      await expect(testId(page, "site-nav")).toBeVisible();
    });

    test("should navigate to about page via link", async ({ page }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/"));
      await waitForHydration(page);

      await using __ = await expectNoReload(page);

      await testId(page, "site-nav-about").click();

      await expect(page).toHaveURL(/\/about/);
      await expect(testId(page, "site-about-page")).toBeVisible();
      await expect(testId(page, "site-about-title")).toHaveText("About");
    });

    test("should render about page on direct visit", async ({ page }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/about"));
      await waitForHydration(page);

      await expect(testId(page, "site-about-page")).toBeVisible();
      await expect(testId(page, "site-about-title")).toHaveText("About");
    });
  });

  test.describe("admin app (admin.localhost)", () => {
    test("should render dashboard page", async ({ page }) => {
      using _ = expectNoPageError(page);

      const adminUrl = f.url("/").replace("localhost", "admin.localhost");
      await page.goto(adminUrl);
      await waitForHydration(page);

      await expect(testId(page, "admin-dashboard-page")).toBeVisible();
      await expect(testId(page, "admin-dashboard-title")).toHaveText(
        "Admin Dashboard",
      );
      await expect(testId(page, "admin-nav")).toBeVisible();
    });

    test("should navigate to users page via link", async ({ page }) => {
      using _ = expectNoPageError(page);

      const adminUrl = f.url("/").replace("localhost", "admin.localhost");
      await page.goto(adminUrl);
      await waitForHydration(page);

      await using __ = await expectNoReload(page);

      await testId(page, "admin-nav-users").click();

      await expect(page).toHaveURL(/\/users/);
      await expect(testId(page, "admin-users-page")).toBeVisible();
      await expect(testId(page, "admin-users-title")).toHaveText("Users");
    });

    test("should render users page on direct visit", async ({ page }) => {
      using _ = expectNoPageError(page);

      const adminUrl = f.url("/users").replace("localhost", "admin.localhost");
      await page.goto(adminUrl);
      await waitForHydration(page);

      await expect(testId(page, "admin-users-page")).toBeVisible();
      await expect(testId(page, "admin-users-title")).toHaveText("Users");
    });
  });

  test.describe("manifest isolation", () => {
    test("/users on site domain should 404", async ({ page }) => {
      const response = await page.goto(f.url("/users"));

      // /users belongs to admin app, should 404 on site domain.
      expect(response!.status()).toBe(404);
    });

    test("/about on admin domain should 404", async ({ page }) => {
      const adminUrl = f.url("/about").replace("localhost", "admin.localhost");
      const response = await page.goto(adminUrl);

      // /about belongs to site app, should 404 on admin domain.
      expect(response!.status()).toBe(404);
    });
  });
});
