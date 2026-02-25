import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import {
  waitForHydration,
  expectNoPageError,
  expectNoReload,
  testId,
} from "./helper";

test.describe.configure({ mode: "serial" });

/**
 * Pre-rendered articles tests (build mode).
 * Verifies that pre-rendered .rsc files (partial format) work correctly
 * for both direct visits (index.html) and client-side navigation (index.rsc).
 */
test.describe("prerender (production)", () => {
  const f = useFixture({
    root: ".",
    mode: "build",
  });

  test("should render articles index on direct visit", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/articles/page/1"));
    await waitForHydration(page);

    await expect(testId(page, "articles-index")).toBeVisible();
    await expect(testId(page, "articles-title")).toHaveText("Articles");
    await expect(testId(page, "articles-list")).toBeVisible();
  });

  test("should render article detail on direct visit", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/articles/composable-patterns"));
    await waitForHydration(page);

    await expect(testId(page, "article-detail")).toBeVisible();
    await expect(testId(page, "article-title")).toHaveText(
      "Composable Patterns",
    );
  });

  test("should navigate to articles via client-side navigation", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // Start on a non-prerendered page
    await page.goto(f.url("/counter"));
    await waitForHydration(page);

    await using __ = await expectNoReload(page);

    // Navigate to pre-rendered articles page via nav link
    await testId(page, "nav-articles").click();
    await expect(testId(page, "articles-index")).toBeVisible();
    await expect(testId(page, "articles-title")).toHaveText("Articles");
  });

  test("should navigate to article detail via client-side navigation", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // Start on a non-prerendered page
    await page.goto(f.url("/counter"));
    await waitForHydration(page);

    await using __ = await expectNoReload(page);

    // Navigate to articles index
    await testId(page, "nav-articles").click();
    await expect(testId(page, "articles-index")).toBeVisible();

    // Click on an article (page 1 has newest articles)
    await testId(page, "article-link-composable-patterns").click();
    await expect(testId(page, "article-detail")).toBeVisible();
    await expect(testId(page, "article-title")).toHaveText(
      "Composable Patterns",
    );
  });

  test("should display breadcrumbs on pre-rendered articles page", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/articles/page/1"));
    await waitForHydration(page);

    const breadcrumbs = testId(page, "breadcrumbs");
    await expect(breadcrumbs).toBeVisible();
    await expect(breadcrumbs.locator("text=Home")).toBeVisible();
    await expect(breadcrumbs.locator("text=Articles")).toBeVisible();
  });

  test("should display breadcrumbs after navigating to articles", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // Start on a non-prerendered page
    await page.goto(f.url("/counter"));
    await waitForHydration(page);

    // Navigate to articles
    await testId(page, "nav-articles").click();
    await expect(testId(page, "articles-index")).toBeVisible();

    const breadcrumbs = testId(page, "breadcrumbs");
    await expect(breadcrumbs).toBeVisible();
    await expect(breadcrumbs.locator("text=Home")).toBeVisible();
    await expect(breadcrumbs.locator("text=Articles")).toBeVisible();
  });

  test("should display breadcrumbs on article detail after navigation", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // Start on a non-prerendered page
    await page.goto(f.url("/counter"));
    await waitForHydration(page);

    // Navigate to articles, then to a detail page
    await testId(page, "nav-articles").click();
    await expect(testId(page, "articles-index")).toBeVisible();

    await testId(page, "article-link-workers-at-edge").click();
    await expect(testId(page, "article-detail")).toBeVisible();

    const breadcrumbs = testId(page, "breadcrumbs");
    await expect(breadcrumbs).toBeVisible();
    await expect(breadcrumbs.locator("text=Home")).toBeVisible();
    await expect(breadcrumbs.locator("text=Articles")).toBeVisible();
    await expect(breadcrumbs.locator("text=Workers at the Edge")).toBeVisible();
  });

  test("should navigate from prerendered articles to blog without fallback", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await page.goto(f.url("/articles/page/1"));
    await waitForHydration(page);

    const warnings: string[] = [];
    page.on("console", (msg) => {
      if (
        msg.type() === "warning" &&
        msg.text().includes("Full update (fallback)")
      ) {
        warnings.push(msg.text());
      }
    });

    await using __ = await expectNoReload(page);

    await testId(page, "nav-blog").click();
    await expect(testId(page, "blog-index")).toBeVisible();
    await expect(testId(page, "blog-title")).toHaveText("Blog");

    // Verify partial update (no fallback render)
    expect(warnings).toEqual([]);
  });

  test("should display meta tags on pre-rendered page", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/articles/page/1"));
    await waitForHydration(page);

    const title = await page.title();
    expect(title).toContain("Articles");
  });

  // -- Releases (node:fs prerender handler) --

  test("should render releases page on direct visit", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/releases"));
    await waitForHydration(page);

    await expect(testId(page, "releases-page")).toBeVisible();
    await expect(page.locator("h1")).toHaveText("Releases");
    await expect(testId(page, "release-2.0.0")).toBeVisible();
    await expect(testId(page, "release-1.0.0")).toBeVisible();
  });

  test("should navigate to releases via client-side navigation", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/counter"));
    await waitForHydration(page);

    await using __ = await expectNoReload(page);

    await testId(page, "nav-releases").click();
    await expect(testId(page, "releases-page")).toBeVisible();
    await expect(testId(page, "release-2.0.0")).toBeVisible();
  });

  // -- Guides (passthrough prerender handler) --

  test("should render guides page on direct visit", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/guides/routing"));
    await waitForHydration(page);

    await expect(testId(page, "guide-detail")).toBeVisible();
    await expect(testId(page, "guide-title")).toHaveText("Routing Guide");
    await expect(testId(page, "guide-slug")).toHaveText("Slug: routing");
  });

  test("should render different guide slug on direct visit", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/guides/caching"));
    await waitForHydration(page);

    await expect(testId(page, "guide-title")).toHaveText("Caching Guide");
    await expect(testId(page, "guide-slug")).toHaveText("Slug: caching");
  });

  test("should navigate to guides via client-side navigation", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/counter"));
    await waitForHydration(page);

    await using __ = await expectNoReload(page);

    await testId(page, "nav-guides").click();
    await expect(testId(page, "guide-detail")).toBeVisible();
    await expect(testId(page, "guide-title")).toHaveText("Routing Guide");
  });
});
