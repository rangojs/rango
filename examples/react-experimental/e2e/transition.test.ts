import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import {
  waitForHydration,
  expectNoPageError,
  testId,
  expectNoReload,
} from "./helper";

test.describe.configure({ mode: "serial" });

test.describe("transition DSL (dev)", () => {
  const f = useFixture({
    root: ".",
    mode: "dev",
  });

  test("should render transition page A on direct visit", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/transition-a"));
    await waitForHydration(page);

    await expect(testId(page, "transition-a-page")).toBeVisible();
    await expect(testId(page, "transition-a-title")).toHaveText(
      "Transition Page A",
    );
  });

  test("should render transition page B on direct visit", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/transition-b"));
    await waitForHydration(page);

    await expect(testId(page, "transition-b-page")).toBeVisible();
    await expect(testId(page, "transition-b-title")).toHaveText(
      "Transition Page B",
    );
  });

  test("should navigate between transition pages via links", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/transition-a"));
    await waitForHydration(page);

    await expect(testId(page, "transition-a-page")).toBeVisible();

    // Navigate to transition B
    await using __ = await expectNoReload(page);
    await testId(page, "nav-transition-b").click();
    await expect(page).toHaveURL(/\/transition-b/);
    await expect(testId(page, "transition-b-page")).toBeVisible();
  });

  test("should navigate from home to transition page", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/"));
    await waitForHydration(page);

    await using __ = await expectNoReload(page);
    await testId(page, "nav-transition-a").click();
    await expect(page).toHaveURL(/\/transition-a/);
    await expect(testId(page, "transition-a-page")).toBeVisible();
  });

  test("should handle back/forward navigation with transition pages", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // Start at transition A
    await page.goto(f.url("/transition-a"));
    await waitForHydration(page);
    await expect(testId(page, "transition-a-page")).toBeVisible();

    // Navigate to transition B
    await testId(page, "nav-transition-b").click();
    await expect(page).toHaveURL(/\/transition-b/);
    await expect(testId(page, "transition-b-page")).toBeVisible();

    // Go back to transition A
    await page.goBack();
    await expect(page).toHaveURL(/\/transition-a/);
    await expect(testId(page, "transition-a-page")).toBeVisible();

    // Go forward to transition B
    await page.goForward();
    await expect(page).toHaveURL(/\/transition-b/);
    await expect(testId(page, "transition-b-page")).toBeVisible();
  });
});

test.describe("gallery named transitions (dev)", () => {
  const f = useFixture({
    root: ".",
    mode: "dev",
  });

  test("should render gallery index on direct visit", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/gallery"));
    await waitForHydration(page);

    await expect(testId(page, "gallery-index-page")).toBeVisible();
    await expect(testId(page, "gallery-index-title")).toHaveText("Gallery");
  });

  test("should render gallery detail on direct visit", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/gallery/1"));
    await waitForHydration(page);

    await expect(testId(page, "gallery-detail-page")).toBeVisible();
    await expect(testId(page, "gallery-detail-title")).toHaveText("Sunset");
  });

  test("should navigate from gallery index to detail via card click", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/gallery"));
    await waitForHydration(page);
    await expect(testId(page, "gallery-index-page")).toBeVisible();

    // Click a card to navigate to detail
    await using __ = await expectNoReload(page);
    await testId(page, "gallery-card-2").click();
    await expect(page).toHaveURL(/\/gallery\/2/);
    await expect(testId(page, "gallery-detail-page")).toBeVisible();
    await expect(testId(page, "gallery-detail-title")).toHaveText("Ocean");
  });

  test("should navigate back from detail to index", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/gallery"));
    await waitForHydration(page);

    // Go to detail
    await testId(page, "gallery-card-3").click();
    await expect(page).toHaveURL(/\/gallery\/3/);
    await expect(testId(page, "gallery-detail-title")).toHaveText("Forest");

    // Click back link
    await using __ = await expectNoReload(page);
    await testId(page, "gallery-back").click();
    await expect(page).toHaveURL(/\/gallery$/);
    await expect(testId(page, "gallery-index-page")).toBeVisible();
  });

  test("should navigate from home to gallery", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/"));
    await waitForHydration(page);

    await using __ = await expectNoReload(page);
    await testId(page, "nav-gallery").click();
    await expect(page).toHaveURL(/\/gallery$/);
    await expect(testId(page, "gallery-index-page")).toBeVisible();
  });
});

test.describe("transition DSL (production)", () => {
  const f = useFixture({
    root: ".",
    mode: "build",
  });

  test("should render transition page A on direct visit", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/transition-a"));
    await waitForHydration(page);

    await expect(testId(page, "transition-a-page")).toBeVisible();
    await expect(testId(page, "transition-a-title")).toHaveText(
      "Transition Page A",
    );
  });

  test("should render transition page B on direct visit", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/transition-b"));
    await waitForHydration(page);

    await expect(testId(page, "transition-b-page")).toBeVisible();
    await expect(testId(page, "transition-b-title")).toHaveText(
      "Transition Page B",
    );
  });

  test("should navigate between transition pages via links", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/transition-a"));
    await waitForHydration(page);

    await using __ = await expectNoReload(page);
    await testId(page, "nav-transition-b").click();
    await expect(page).toHaveURL(/\/transition-b/);
    await expect(testId(page, "transition-b-page")).toBeVisible();
  });

  test("should handle back/forward navigation with transition pages", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/transition-a"));
    await waitForHydration(page);
    await expect(testId(page, "transition-a-page")).toBeVisible();

    // Navigate to transition B
    await testId(page, "nav-transition-b").click();
    await expect(page).toHaveURL(/\/transition-b/);
    await expect(testId(page, "transition-b-page")).toBeVisible();

    // Go back
    await page.goBack();
    await expect(page).toHaveURL(/\/transition-a/);
    await expect(testId(page, "transition-a-page")).toBeVisible();
  });

  test("should render gallery index in production", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/gallery"));
    await waitForHydration(page);

    await expect(testId(page, "gallery-index-page")).toBeVisible();
    await expect(testId(page, "gallery-index-title")).toHaveText("Gallery");
  });

  test("should navigate from gallery to detail in production", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/gallery"));
    await waitForHydration(page);

    await using __ = await expectNoReload(page);
    await testId(page, "gallery-card-1").click();
    await expect(page).toHaveURL(/\/gallery\/1/);
    await expect(testId(page, "gallery-detail-page")).toBeVisible();
    await expect(testId(page, "gallery-detail-title")).toHaveText("Sunset");
  });
});
