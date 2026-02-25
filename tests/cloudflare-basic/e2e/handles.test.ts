import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError, testId } from "./helper";

test.describe.configure({ mode: "serial" });

/**
 * Handle API tests - breadcrumbs accumulated across route segments
 */
test.describe("handles", () => {
  const f = useFixture({
    root: ".",
    mode: "dev",
  });

  test("should display home breadcrumb on index page", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/"));
    await waitForHydration(page);

    const breadcrumbs = testId(page, "breadcrumbs");
    await expect(breadcrumbs).toBeVisible();
    await expect(breadcrumbs.locator("text=Home")).toBeVisible();
  });

  test("should display nested breadcrumbs on about page", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/about"));
    await waitForHydration(page);

    const breadcrumbs = testId(page, "breadcrumbs");
    await expect(breadcrumbs).toBeVisible();
    await expect(breadcrumbs.locator("text=Home")).toBeVisible();
    await expect(breadcrumbs.locator("text=About")).toBeVisible();
  });

  test("should display nested breadcrumbs on counter page", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/counter"));
    await waitForHydration(page);

    const breadcrumbs = testId(page, "breadcrumbs");
    await expect(breadcrumbs).toBeVisible();
    await expect(breadcrumbs.locator("text=Home")).toBeVisible();
    await expect(breadcrumbs.locator("text=Counter")).toBeVisible();
  });

  test("should display breadcrumbs on feature page", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/features/server-components"));
    await waitForHydration(page);

    const breadcrumbs = testId(page, "breadcrumbs");
    await expect(breadcrumbs).toBeVisible();
    await expect(breadcrumbs.locator("text=Home")).toBeVisible();
    await expect(breadcrumbs.locator("text=Server Components")).toBeVisible();
  });

  test("should update breadcrumbs on navigation", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/"));
    await waitForHydration(page);

    const breadcrumbs = testId(page, "breadcrumbs");

    // Initially only "Home" breadcrumb
    await expect(breadcrumbs.locator("text=Home")).toBeVisible();
    await expect(breadcrumbs.locator("text=About")).not.toBeVisible();

    // Navigate to about page
    await testId(page, "nav-about").click();
    await expect(testId(page, "about-page")).toBeVisible();

    // Breadcrumbs should now include About
    await expect(breadcrumbs.locator("text=Home")).toBeVisible();
    await expect(breadcrumbs.locator("text=About")).toBeVisible();
  });

  test("should navigate via breadcrumb link", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/about"));
    await waitForHydration(page);

    const breadcrumbs = testId(page, "breadcrumbs");
    await expect(breadcrumbs.locator("text=About")).toBeVisible();

    // Click the Home breadcrumb link
    await testId(page, "breadcrumb-link-home").click();

    // Should navigate to home page
    await expect(testId(page, "home-page")).toBeVisible();

    // About breadcrumb should be gone
    await expect(breadcrumbs.locator("text=About")).not.toBeVisible();
  });

  test("should not show hydration mismatch for breadcrumbs", async ({
    page,
  }) => {
    const hydrationErrors: string[] = [];

    page.on("console", (msg) => {
      const text = msg.text();
      if (
        text.includes("Hydration failed") ||
        text.includes("hydration mismatch") ||
        text.includes("Text content does not match")
      ) {
        hydrationErrors.push(text);
      }
    });

    // Test various pages for hydration issues
    await page.goto(f.url("/"));
    await waitForHydration(page);
    expect(hydrationErrors).toEqual([]);

    await page.goto(f.url("/about"));
    await waitForHydration(page);
    expect(hydrationErrors).toEqual([]);

    await page.goto(f.url("/counter"));
    await waitForHydration(page);
    expect(hydrationErrors).toEqual([]);

    await page.goto(f.url("/features/streaming"));
    await waitForHydration(page);
    expect(hydrationErrors).toEqual([]);
  });
});
