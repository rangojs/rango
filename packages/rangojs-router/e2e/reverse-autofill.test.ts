import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError, testId } from "./helper";

/**
 * Tests for reverse auto-fill of mount params.
 *
 * When routes are mounted via include("/reverse-autofill/:tenantId", patterns),
 * inner handlers should be able to call ctx.reverse(".localName") without
 * explicitly passing tenantId — it is auto-filled from ctx.params.
 */

test.describe("reverse-autofill", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });

  test.describe("SSR — index page auto-fills tenantId", () => {
    test("should auto-fill tenantId in local .settings reverse", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/reverse-autofill/acme"));
      await waitForHydration(page);

      await expect(testId(page, "autofill-index-page")).toBeVisible();
      await expect(testId(page, "autofill-index-title")).toContainText(
        "Tenant: acme",
      );
      await expect(testId(page, "autofill-settings-url")).toContainText(
        "/reverse-autofill/acme/settings",
      );
    });

    test("should auto-fill tenantId and accept explicit userId", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/reverse-autofill/acme"));
      await waitForHydration(page);

      await expect(testId(page, "autofill-user-url")).toContainText(
        "/reverse-autofill/acme/users/u1",
      );
    });

    test("should allow explicit tenantId to override auto-fill", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/reverse-autofill/acme"));
      await waitForHydration(page);

      await expect(testId(page, "autofill-override-url")).toContainText(
        "/reverse-autofill/override/settings",
      );
    });

    test("should auto-fill tenantId in global route name", async ({ page }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/reverse-autofill/acme"));
      await waitForHydration(page);

      await expect(testId(page, "autofill-global-settings-url")).toContainText(
        "/reverse-autofill/acme/settings",
      );
    });
  });

  test.describe("SSR — settings page auto-fills tenantId", () => {
    test("should auto-fill tenantId when reversing back to index", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/reverse-autofill/acme/settings"));
      await waitForHydration(page);

      await expect(testId(page, "autofill-settings-page")).toBeVisible();
      await expect(testId(page, "autofill-settings-title")).toContainText(
        "Settings for: acme",
      );
      await expect(testId(page, "autofill-back-index-url")).toContainText(
        "/reverse-autofill/acme",
      );
    });

    test("should auto-fill tenantId with explicit userId from settings", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/reverse-autofill/acme/settings"));
      await waitForHydration(page);

      await expect(testId(page, "autofill-settings-user-url")).toContainText(
        "/reverse-autofill/acme/users/u2",
      );
    });
  });

  test.describe("SSR — user page with two params", () => {
    test("should auto-fill tenantId when reversing to settings", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/reverse-autofill/acme/users/u1"));
      await waitForHydration(page);

      await expect(testId(page, "autofill-user-page")).toBeVisible();
      await expect(testId(page, "autofill-user-title")).toContainText(
        "User: u1 (tenant: acme)",
      );
      await expect(testId(page, "autofill-user-settings-url")).toContainText(
        "/reverse-autofill/acme/settings",
      );
    });

    test("should auto-fill tenantId when reversing to index", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/reverse-autofill/acme/users/u1"));
      await waitForHydration(page);

      await expect(testId(page, "autofill-user-index-url")).toContainText(
        "/reverse-autofill/acme",
      );
    });

    test("should auto-fill tenantId for another user link", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/reverse-autofill/acme/users/u1"));
      await waitForHydration(page);

      await expect(testId(page, "autofill-user-other-url")).toContainText(
        "/reverse-autofill/acme/users/other",
      );
    });
  });

  test.describe("SSR — different param values", () => {
    test("should use correct tenantId for different tenant", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/reverse-autofill/beta"));
      await waitForHydration(page);

      await expect(testId(page, "autofill-index-title")).toContainText(
        "Tenant: beta",
      );
      await expect(testId(page, "autofill-settings-url")).toContainText(
        "/reverse-autofill/beta/settings",
      );
      await expect(testId(page, "autofill-user-url")).toContainText(
        "/reverse-autofill/beta/users/u1",
      );
    });
  });

  test.describe("client-side navigation", () => {
    test("should navigate from index to settings with auto-filled URLs", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/reverse-autofill/acme"));
      await waitForHydration(page);

      await testId(page, "autofill-link-settings").click();
      await expect(page).toHaveURL(/\/reverse-autofill\/acme\/settings/);
      await expect(testId(page, "autofill-settings-page")).toBeVisible();
      await expect(testId(page, "autofill-back-index-url")).toContainText(
        "/reverse-autofill/acme",
      );
    });

    test("should navigate from settings back to index", async ({ page }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/reverse-autofill/acme/settings"));
      await waitForHydration(page);

      await testId(page, "autofill-link-back-index").click();
      await expect(page).toHaveURL(/\/reverse-autofill\/acme$/);
      await expect(testId(page, "autofill-index-page")).toBeVisible();
      await expect(testId(page, "autofill-settings-url")).toContainText(
        "/reverse-autofill/acme/settings",
      );
    });

    test("should navigate from index to user page", async ({ page }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/reverse-autofill/acme"));
      await waitForHydration(page);

      await testId(page, "autofill-link-user").click();
      await expect(page).toHaveURL(/\/reverse-autofill\/acme\/users\/u1/);
      await expect(testId(page, "autofill-user-page")).toBeVisible();
      await expect(testId(page, "autofill-user-settings-url")).toContainText(
        "/reverse-autofill/acme/settings",
      );
    });

    test("should navigate from user page to settings", async ({ page }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/reverse-autofill/acme/users/u1"));
      await waitForHydration(page);

      await testId(page, "autofill-link-user-settings").click();
      await expect(page).toHaveURL(/\/reverse-autofill\/acme\/settings/);
      await expect(testId(page, "autofill-settings-page")).toBeVisible();
    });

    test("should navigate from user page back to index", async ({ page }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/reverse-autofill/acme/users/u1"));
      await waitForHydration(page);

      await testId(page, "autofill-link-user-back").click();
      await expect(page).toHaveURL(/\/reverse-autofill\/acme$/);
      await expect(testId(page, "autofill-index-page")).toBeVisible();
    });
  });
});

test.describe("reverse-autofill (production)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "build",
  });

  test.describe("SSR — index page auto-fills tenantId", () => {
    test("should auto-fill tenantId in local .settings reverse", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/reverse-autofill/acme"));
      await waitForHydration(page);

      await expect(testId(page, "autofill-index-page")).toBeVisible();
      await expect(testId(page, "autofill-index-title")).toContainText(
        "Tenant: acme",
      );
      await expect(testId(page, "autofill-settings-url")).toContainText(
        "/reverse-autofill/acme/settings",
      );
    });

    test("should auto-fill tenantId and accept explicit userId", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/reverse-autofill/acme"));
      await waitForHydration(page);

      await expect(testId(page, "autofill-user-url")).toContainText(
        "/reverse-autofill/acme/users/u1",
      );
    });

    test("should allow explicit tenantId to override auto-fill", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/reverse-autofill/acme"));
      await waitForHydration(page);

      await expect(testId(page, "autofill-override-url")).toContainText(
        "/reverse-autofill/override/settings",
      );
    });

    test("should auto-fill tenantId in global route name", async ({ page }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/reverse-autofill/acme"));
      await waitForHydration(page);

      await expect(testId(page, "autofill-global-settings-url")).toContainText(
        "/reverse-autofill/acme/settings",
      );
    });
  });

  test.describe("SSR — settings page auto-fills tenantId", () => {
    test("should auto-fill tenantId when reversing back to index", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/reverse-autofill/acme/settings"));
      await waitForHydration(page);

      await expect(testId(page, "autofill-settings-page")).toBeVisible();
      await expect(testId(page, "autofill-settings-title")).toContainText(
        "Settings for: acme",
      );
      await expect(testId(page, "autofill-back-index-url")).toContainText(
        "/reverse-autofill/acme",
      );
    });

    test("should auto-fill tenantId with explicit userId from settings", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/reverse-autofill/acme/settings"));
      await waitForHydration(page);

      await expect(testId(page, "autofill-settings-user-url")).toContainText(
        "/reverse-autofill/acme/users/u2",
      );
    });
  });

  test.describe("SSR — user page with two params", () => {
    test("should auto-fill tenantId when reversing to settings", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/reverse-autofill/acme/users/u1"));
      await waitForHydration(page);

      await expect(testId(page, "autofill-user-page")).toBeVisible();
      await expect(testId(page, "autofill-user-title")).toContainText(
        "User: u1 (tenant: acme)",
      );
      await expect(testId(page, "autofill-user-settings-url")).toContainText(
        "/reverse-autofill/acme/settings",
      );
    });

    test("should auto-fill tenantId when reversing to index", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/reverse-autofill/acme/users/u1"));
      await waitForHydration(page);

      await expect(testId(page, "autofill-user-index-url")).toContainText(
        "/reverse-autofill/acme",
      );
    });

    test("should auto-fill tenantId for another user link", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/reverse-autofill/acme/users/u1"));
      await waitForHydration(page);

      await expect(testId(page, "autofill-user-other-url")).toContainText(
        "/reverse-autofill/acme/users/other",
      );
    });
  });

  test.describe("SSR — different param values", () => {
    test("should use correct tenantId for different tenant", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/reverse-autofill/beta"));
      await waitForHydration(page);

      await expect(testId(page, "autofill-index-title")).toContainText(
        "Tenant: beta",
      );
      await expect(testId(page, "autofill-settings-url")).toContainText(
        "/reverse-autofill/beta/settings",
      );
      await expect(testId(page, "autofill-user-url")).toContainText(
        "/reverse-autofill/beta/users/u1",
      );
    });
  });

  test.describe("client-side navigation", () => {
    test("should navigate from index to settings with auto-filled URLs", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/reverse-autofill/acme"));
      await waitForHydration(page);

      await testId(page, "autofill-link-settings").click();
      await expect(page).toHaveURL(/\/reverse-autofill\/acme\/settings/);
      await expect(testId(page, "autofill-settings-page")).toBeVisible();
      await expect(testId(page, "autofill-back-index-url")).toContainText(
        "/reverse-autofill/acme",
      );
    });

    test("should navigate from settings back to index", async ({ page }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/reverse-autofill/acme/settings"));
      await waitForHydration(page);

      await testId(page, "autofill-link-back-index").click();
      await expect(page).toHaveURL(/\/reverse-autofill\/acme$/);
      await expect(testId(page, "autofill-index-page")).toBeVisible();
      await expect(testId(page, "autofill-settings-url")).toContainText(
        "/reverse-autofill/acme/settings",
      );
    });

    test("should navigate from index to user page", async ({ page }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/reverse-autofill/acme"));
      await waitForHydration(page);

      await testId(page, "autofill-link-user").click();
      await expect(page).toHaveURL(/\/reverse-autofill\/acme\/users\/u1/);
      await expect(testId(page, "autofill-user-page")).toBeVisible();
      await expect(testId(page, "autofill-user-settings-url")).toContainText(
        "/reverse-autofill/acme/settings",
      );
    });

    test("should navigate from user page to settings", async ({ page }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/reverse-autofill/acme/users/u1"));
      await waitForHydration(page);

      await testId(page, "autofill-link-user-settings").click();
      await expect(page).toHaveURL(/\/reverse-autofill\/acme\/settings/);
      await expect(testId(page, "autofill-settings-page")).toBeVisible();
    });

    test("should navigate from user page back to index", async ({ page }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/reverse-autofill/acme/users/u1"));
      await waitForHydration(page);

      await testId(page, "autofill-link-user-back").click();
      await expect(page).toHaveURL(/\/reverse-autofill\/acme$/);
      await expect(testId(page, "autofill-index-page")).toBeVisible();
    });
  });
});
