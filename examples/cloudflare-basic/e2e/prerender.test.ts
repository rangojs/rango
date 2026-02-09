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
test.describe("prerender", () => {
  const f = useFixture({
    root: ".",
    mode: "build",
  });

  test("should render articles index on direct visit", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/articles"));
    await waitForHydration(page);

    await expect(testId(page, "articles-index")).toBeVisible();
    await expect(testId(page, "articles-title")).toHaveText("Articles");
    await expect(testId(page, "articles-list")).toBeVisible();
  });

  test("should render article detail on direct visit", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/articles/what-is-prerendering"));
    await waitForHydration(page);

    await expect(testId(page, "article-detail")).toBeVisible();
    await expect(testId(page, "article-title")).toHaveText(
      "What is Pre-rendering?"
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

    // Click on an article
    await testId(page, "article-link-what-is-prerendering").click();
    await expect(testId(page, "article-detail")).toBeVisible();
    await expect(testId(page, "article-title")).toHaveText(
      "What is Pre-rendering?"
    );
  });

  test("should display breadcrumbs on pre-rendered articles page", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/articles"));
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

    await testId(page, "article-link-static-params").click();
    await expect(testId(page, "article-detail")).toBeVisible();

    const breadcrumbs = testId(page, "breadcrumbs");
    await expect(breadcrumbs).toBeVisible();
    await expect(breadcrumbs.locator("text=Home")).toBeVisible();
    await expect(breadcrumbs.locator("text=Articles")).toBeVisible();
    await expect(
      breadcrumbs.locator("text=Static Params with getParams")
    ).toBeVisible();
  });

  test("should navigate from prerendered articles to blog without fallback", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await page.goto(f.url("/articles"));
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

    await page.goto(f.url("/articles"));
    await waitForHydration(page);

    const title = await page.title();
    expect(title).toContain("Articles");
  });
});
