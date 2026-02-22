import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import {
  waitForHydration,
  expectNoPageError,
  testId,
} from "./helper";

test.describe.configure({ mode: "serial" });

test.describe("prerender handler (dev)", () => {
  const f = useFixture({
    root: ".",
    mode: "dev",
  });

  test("should render prerender page on direct visit", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/prerender"));
    await waitForHydration(page);

    await expect(testId(page, "prerender-page")).toBeVisible();
    await expect(testId(page, "prerender-title")).toHaveText("Pre-rendered Page");
    await expect(testId(page, "prerender-content")).toHaveText(
      "This page is pre-rendered.",
    );
  });

  test("should render parameterized prerender page", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/prerender/hello"));
    await waitForHydration(page);

    await expect(testId(page, "prerender-article")).toBeVisible();
    await expect(testId(page, "prerender-article-title")).toHaveText("hello");
    await expect(testId(page, "prerender-article-content")).toHaveText(
      "Content for hello",
    );
  });

  test("should render different param values", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/prerender/world"));
    await waitForHydration(page);

    await expect(testId(page, "prerender-article-title")).toHaveText("world");
    await expect(testId(page, "prerender-article-content")).toHaveText(
      "Content for world",
    );
  });

  test("should navigate to prerender page via link", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/"));
    await waitForHydration(page);

    await testId(page, "nav-prerender").click();

    await expect(page).toHaveURL(/\/prerender/);
    await expect(testId(page, "prerender-page")).toBeVisible();
    await expect(testId(page, "prerender-title")).toHaveText("Pre-rendered Page");
  });
});

test.describe("prerender handler (production)", () => {
  const f = useFixture({
    root: ".",
    mode: "build",
  });

  test("should render prerender page on direct visit", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/prerender"));
    await waitForHydration(page);

    await expect(testId(page, "prerender-page")).toBeVisible();
    await expect(testId(page, "prerender-title")).toHaveText("Pre-rendered Page");
  });

  test("should have stable timestamp across reloads (truly pre-rendered)", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/prerender"));
    await waitForHydration(page);

    const ts1 = await testId(page, "prerender-timestamp").textContent();

    await page.reload();
    await waitForHydration(page);

    const ts2 = await testId(page, "prerender-timestamp").textContent();

    expect(ts1).toBe(ts2);
  });

  test("should render parameterized prerender page on direct visit", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/prerender/hello"));
    await waitForHydration(page);

    await expect(testId(page, "prerender-article")).toBeVisible();
    await expect(testId(page, "prerender-article-title")).toHaveText("hello");
    await expect(testId(page, "prerender-article-content")).toHaveText(
      "Content for hello",
    );
  });

  test("should have stable article timestamp across reloads", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/prerender/hello"));
    await waitForHydration(page);

    const ts1 = await testId(page, "prerender-article-timestamp").textContent();

    await page.reload();
    await waitForHydration(page);

    const ts2 = await testId(page, "prerender-article-timestamp").textContent();

    expect(ts1).toBe(ts2);
  });

  test("should render different param on direct visit", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/prerender/world"));
    await waitForHydration(page);

    await expect(testId(page, "prerender-article-title")).toHaveText("world");
  });

  test("should navigate to prerender page via client-side navigation", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/counter"));
    await waitForHydration(page);

    await testId(page, "nav-prerender").click();
    await expect(testId(page, "prerender-page")).toBeVisible();
    await expect(testId(page, "prerender-title")).toHaveText("Pre-rendered Page");
  });
});
