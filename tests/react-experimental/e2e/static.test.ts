import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError, testId } from "./helper";

test.describe.configure({ mode: "serial" });

test.describe("static handler (dev)", () => {
  const f = useFixture({
    root: ".",
    mode: "dev",
  });

  test("should render static page on direct visit", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/static"));
    await waitForHydration(page);

    await expect(testId(page, "static-page")).toBeVisible();
    await expect(testId(page, "static-title")).toHaveText("Static Page");
    await expect(testId(page, "static-content")).toHaveText(
      "This page is statically rendered at build time.",
    );
    await expect(testId(page, "static-timestamp")).toBeVisible();
  });

  test("should navigate to static page via link", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/"));
    await waitForHydration(page);

    await testId(page, "nav-static").click();

    await expect(page).toHaveURL(/\/static/);
    await expect(testId(page, "static-page")).toBeVisible();
    await expect(testId(page, "static-title")).toHaveText("Static Page");
  });
});

test.describe("static handler (production)", () => {
  const f = useFixture({
    root: ".",
    mode: "build",
  });

  test("should render static page on direct visit", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/static"));
    await waitForHydration(page);

    await expect(testId(page, "static-page")).toBeVisible();
    await expect(testId(page, "static-title")).toHaveText("Static Page");
    await expect(testId(page, "static-content")).toHaveText(
      "This page is statically rendered at build time.",
    );
  });

  test("should have stable timestamp across reloads (truly pre-rendered)", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/static"));
    await waitForHydration(page);

    const ts1 = await testId(page, "static-timestamp").textContent();

    await page.reload();
    await waitForHydration(page);

    const ts2 = await testId(page, "static-timestamp").textContent();

    // If truly pre-rendered, timestamp should be identical (frozen at build time)
    expect(ts1).toBe(ts2);
  });

  test("should navigate to static page via client-side navigation", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/"));
    await waitForHydration(page);

    await testId(page, "nav-static").click();

    await expect(testId(page, "static-page")).toBeVisible();
    await expect(testId(page, "static-title")).toHaveText("Static Page");
  });
});
