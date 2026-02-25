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
 * Complex pre-render tests: layout, pagination via handler-first ctx.set/ctx.get,
 * and cross-route navigation with pre-rendered routes.
 *
 * Route structure:
 *   layout(ArticlesLayout)                        -- runtime (wraps all)
 *     path("/:page(1|2|3|4)", PaginatedArticles,  -- prerendered
 *       () => [layout(PaginationLayout)])          -- reads ctx.get("pagination")
 *     path("/:slug", ArticleDetail)               -- prerendered
 */
test.describe("prerender-complex (production)", () => {
  const f = useFixture({
    root: ".",
    mode: "build",
  });

  // -- Layout tests --

  test("layout renders on direct visit", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/articles/page/1"));
    await waitForHydration(page);

    await expect(testId(page, "articles-layout")).toBeVisible();
    await expect(testId(page, "articles-index")).toBeVisible();
  });

  test("layout renders on client navigation", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/counter"));
    await waitForHydration(page);

    await using __ = await expectNoReload(page);

    await testId(page, "nav-articles").click();
    await expect(testId(page, "articles-layout")).toBeVisible();
    await expect(testId(page, "articles-index")).toBeVisible();
  });

  test("layout preserved between article details", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/articles/page/1"));
    await waitForHydration(page);

    await using __ = await expectNoReload(page);

    // Navigate to first article
    await testId(page, "article-link-composable-patterns").click();
    await expect(testId(page, "article-detail")).toBeVisible();
    await expect(testId(page, "articles-layout")).toBeVisible();

    // Navigate back to articles list
    await page.locator("text=Back to Articles").click();
    await expect(testId(page, "articles-index")).toBeVisible();
    await expect(testId(page, "articles-layout")).toBeVisible();

    // Navigate to a different article
    await testId(page, "article-link-workers-at-edge").click();
    await expect(testId(page, "article-detail")).toBeVisible();
    await expect(testId(page, "articles-layout")).toBeVisible();
  });

  test("layout wraps both list and detail routes", async ({ page }) => {
    using _ = expectNoPageError(page);

    // Layout visible on list
    await page.goto(f.url("/articles/page/1"));
    await waitForHydration(page);
    await expect(testId(page, "articles-layout")).toBeVisible();
    await expect(testId(page, "layout-rendered-at")).toBeVisible();

    // Layout also visible on detail
    await page.goto(f.url("/articles/what-is-prerendering"));
    await waitForHydration(page);
    await expect(testId(page, "articles-layout")).toBeVisible();
    await expect(testId(page, "layout-rendered-at")).toBeVisible();
  });

  // -- Pagination layout tests (handler-first ctx.set/ctx.get) --

  test("pagination layout renders with correct page info", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/articles/page/1"));
    await waitForHydration(page);

    await expect(testId(page, "pagination-layout")).toBeVisible();
    await expect(testId(page, "pagination-info")).toContainText("Page 1 of");
  });

  test("pagination layout not present on article detail", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/articles/what-is-prerendering"));
    await waitForHydration(page);

    await expect(testId(page, "article-detail")).toBeVisible();
    await expect(testId(page, "pagination-layout")).not.toBeVisible();
  });

  // -- Navigation tests --

  test("navigate between prerendered articles without reload", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/articles/page/1"));
    await waitForHydration(page);

    await using __ = await expectNoReload(page);

    // Click first article
    await testId(page, "article-link-composable-patterns").click();
    await expect(testId(page, "article-title")).toHaveText(
      "Composable Patterns",
    );

    // Go back
    await page.locator("text=Back to Articles").click();
    await expect(testId(page, "articles-index")).toBeVisible();

    // Click second article
    await testId(page, "article-link-workers-at-edge").click();
    await expect(testId(page, "article-title")).toHaveText(
      "Workers at the Edge",
    );
  });

  test("breadcrumbs update correctly through layout", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/counter"));
    await waitForHydration(page);

    // Navigate to articles
    await testId(page, "nav-articles").click();
    await expect(testId(page, "articles-index")).toBeVisible();

    const breadcrumbs = testId(page, "breadcrumbs");
    await expect(breadcrumbs).toBeVisible();
    await expect(breadcrumbs.locator("text=Home")).toBeVisible();
    await expect(breadcrumbs.locator("text=Articles")).toBeVisible();

    // Click into article detail
    await testId(page, "article-link-composable-patterns").click();
    await expect(testId(page, "article-detail")).toBeVisible();

    await expect(breadcrumbs.locator("text=Home")).toBeVisible();
    await expect(breadcrumbs.locator("text=Articles")).toBeVisible();
    await expect(breadcrumbs.locator("text=Composable Patterns")).toBeVisible();
  });

  test("meta tags update between prerendered articles", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/articles/page/1"));
    await waitForHydration(page);

    // Articles list title
    let title = await page.title();
    expect(title).toContain("Articles");

    // Navigate to article detail
    await testId(page, "article-link-composable-patterns").click();
    await expect(testId(page, "article-detail")).toBeVisible();

    title = await page.title();
    expect(title).toContain("Composable Patterns");

    // Navigate back to articles list
    await page.locator("text=Back to Articles").click();
    await expect(testId(page, "articles-index")).toBeVisible();

    title = await page.title();
    expect(title).toContain("Articles");
  });

  test("back/forward navigation with prerendered routes", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/counter"));
    await waitForHydration(page);

    // Navigate to articles
    await testId(page, "nav-articles").click();
    await expect(testId(page, "articles-index")).toBeVisible();

    // Navigate to article detail
    await testId(page, "article-link-composable-patterns").click();
    await expect(testId(page, "article-title")).toHaveText(
      "Composable Patterns",
    );

    // Browser back -> articles list
    await page.goBack();
    await expect(testId(page, "articles-index")).toBeVisible();

    // Browser back -> counter
    await page.goBack();
    await expect(testId(page, "counter-page")).toBeVisible();

    // Browser forward -> articles
    await page.goForward();
    await expect(testId(page, "articles-index")).toBeVisible();
  });

  // -- Cross-route navigation tests --

  test("non-prerendered to prerendered to non-prerendered", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/counter"));
    await waitForHydration(page);

    await using __ = await expectNoReload(page);

    // counter (non-prerendered) -> articles (prerendered)
    await testId(page, "nav-articles").click();
    await expect(testId(page, "articles-index")).toBeVisible();
    await expect(testId(page, "articles-layout")).toBeVisible();

    // articles (prerendered) -> about (non-prerendered)
    await testId(page, "nav-about").click();
    await expect(testId(page, "about-page")).toBeVisible();
  });
});

/**
 * Dev mode: same route structure, no pre-rendering.
 * All handlers run live at request time.
 */
test.describe("prerender-complex (dev)", () => {
  const f = useFixture({
    root: ".",
    mode: "dev",
  });

  // -- Layout --

  test("layout renders on direct visit", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/articles/page/1"));
    await waitForHydration(page);

    await expect(testId(page, "articles-layout")).toBeVisible();
    await expect(testId(page, "articles-index")).toBeVisible();
  });

  test("layout renders on client navigation", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/counter"));
    await waitForHydration(page);

    await using __ = await expectNoReload(page);

    await testId(page, "nav-articles").click();
    await expect(testId(page, "articles-layout")).toBeVisible();
    await expect(testId(page, "articles-index")).toBeVisible();
  });

  // -- Pagination layout --

  test("pagination layout renders on list page", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/articles/page/1"));
    await waitForHydration(page);

    await expect(testId(page, "pagination-layout")).toBeVisible();
    await expect(testId(page, "pagination-info")).toContainText("Page 1 of");
  });

  test("pagination layout not present on article detail", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/articles/what-is-prerendering"));
    await waitForHydration(page);

    await expect(testId(page, "article-detail")).toBeVisible();
    await expect(testId(page, "pagination-layout")).not.toBeVisible();
  });

  // -- Navigation --

  test("navigate between articles without reload", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/articles/page/1"));
    await waitForHydration(page);

    await using __ = await expectNoReload(page);

    await testId(page, "article-link-composable-patterns").click();
    await expect(testId(page, "article-title")).toHaveText(
      "Composable Patterns",
    );

    await page.locator("text=Back to Articles").click();
    await expect(testId(page, "articles-index")).toBeVisible();

    await testId(page, "article-link-workers-at-edge").click();
    await expect(testId(page, "article-title")).toHaveText(
      "Workers at the Edge",
    );
  });

  test("cross-route navigation", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/counter"));
    await waitForHydration(page);

    await using __ = await expectNoReload(page);

    await testId(page, "nav-articles").click();
    await expect(testId(page, "articles-index")).toBeVisible();
    await expect(testId(page, "articles-layout")).toBeVisible();

    await testId(page, "nav-about").click();
    await expect(testId(page, "about-page")).toBeVisible();
  });
});
