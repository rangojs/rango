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
 * Complex pre-render tests: layout, parallel slots, loader freshness,
 * and cross-route navigation with pre-rendered routes.
 *
 * Route structure:
 *   layout(ArticlesLayout)              -- runtime (wraps all)
 *     path("/", ArticlesIndex, () => [  -- prerendered
 *       parallel(@stats)                -- prerendered structure, useLoader for fresh data
 *         loader(ArticleStatsLoader)
 *     ])
 *     path("/:slug", ArticleDetail)     -- prerendered
 */
test.describe("prerender-complex", () => {
  const f = useFixture({
    root: ".",
    mode: "build",
  });

  // -- Layout tests --

  test("layout renders on direct visit", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/articles"));
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

    await page.goto(f.url("/articles"));
    await waitForHydration(page);

    await using __ = await expectNoReload(page);

    // Navigate to first article
    await testId(page, "article-link-what-is-prerendering").click();
    await expect(testId(page, "article-detail")).toBeVisible();
    await expect(testId(page, "articles-layout")).toBeVisible();

    // Navigate back to articles index
    await page.locator("text=Back to Articles").click();
    await expect(testId(page, "articles-index")).toBeVisible();
    await expect(testId(page, "articles-layout")).toBeVisible();

    // Navigate to a different article
    await testId(page, "article-link-static-params").click();
    await expect(testId(page, "article-detail")).toBeVisible();
    await expect(testId(page, "articles-layout")).toBeVisible();
  });

  test("layout wraps both index and detail routes", async ({ page }) => {
    using _ = expectNoPageError(page);

    // Layout visible on index
    await page.goto(f.url("/articles"));
    await waitForHydration(page);
    await expect(testId(page, "articles-layout")).toBeVisible();
    await expect(testId(page, "layout-rendered-at")).toBeVisible();

    // Layout also visible on detail
    await page.goto(f.url("/articles/what-is-prerendering"));
    await waitForHydration(page);
    await expect(testId(page, "articles-layout")).toBeVisible();
    await expect(testId(page, "layout-rendered-at")).toBeVisible();
  });

  // -- Parallel slot tests --
  // The @stats parallel is a child of path("/") — scoped to index only.

  test("stats sidebar renders on index direct visit", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/articles"));
    await waitForHydration(page);

    await expect(testId(page, "articles-stats-sidebar")).toBeVisible();
    await expect(testId(page, "stats-rendered-at")).toBeVisible();
  });

  test("stats sidebar renders on index client navigation", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/counter"));
    await waitForHydration(page);

    await using __ = await expectNoReload(page);

    await testId(page, "nav-articles").click();
    await expect(testId(page, "articles-stats-sidebar")).toBeVisible();
    await expect(testId(page, "stats-rendered-at")).toBeVisible();
  });

  test("stats sidebar not present on article detail", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/articles/what-is-prerendering"));
    await waitForHydration(page);

    await expect(testId(page, "article-detail")).toBeVisible();
    await expect(testId(page, "articles-stats-sidebar")).not.toBeVisible();
  });

  // -- Loader data tests --
  // Loader data via useLoader is SSR'd and displayed correctly.

  test("loader data renders valid timestamp", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/articles"));
    await waitForHydration(page);

    const text = await testId(page, "stats-rendered-at").textContent();
    expect(text).toBeTruthy();

    // Verify the timestamp is a valid ISO date string
    const match = text!.match(/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/);
    expect(match).toBeTruthy();

    const renderedAt = new Date(match![1]);
    expect(renderedAt.getTime()).not.toBeNaN();
  });

  test("loader re-executes on each navigation (not cached)", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/articles"));
    await waitForHydration(page);

    const text1 = await testId(page, "stats-rendered-at").textContent();
    expect(text1).toBeTruthy();

    // Navigate away and back — loader should re-execute
    await testId(page, "nav-counter").click();
    await expect(testId(page, "counter-page")).toBeVisible();

    await testId(page, "nav-articles").click();
    await expect(testId(page, "articles-stats-sidebar")).toBeVisible();

    const text2 = await testId(page, "stats-rendered-at").textContent();
    expect(text2).toBeTruthy();

    // Loader runs fresh each time — timestamps must differ
    expect(text2).not.toEqual(text1);
  });

  // -- Navigation tests --

  test("navigate between prerendered articles without reload", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/articles"));
    await waitForHydration(page);

    await using __ = await expectNoReload(page);

    // Click first article
    await testId(page, "article-link-what-is-prerendering").click();
    await expect(testId(page, "article-title")).toHaveText(
      "What is Pre-rendering?"
    );

    // Go back
    await page.locator("text=Back to Articles").click();
    await expect(testId(page, "articles-index")).toBeVisible();

    // Click second article
    await testId(page, "article-link-static-params").click();
    await expect(testId(page, "article-title")).toHaveText(
      "Static Params with getParams"
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
    await testId(page, "article-link-what-is-prerendering").click();
    await expect(testId(page, "article-detail")).toBeVisible();

    await expect(breadcrumbs.locator("text=Home")).toBeVisible();
    await expect(breadcrumbs.locator("text=Articles")).toBeVisible();
    await expect(
      breadcrumbs.locator("text=What is Pre-rendering?")
    ).toBeVisible();
  });

  test("meta tags update between prerendered articles", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/articles"));
    await waitForHydration(page);

    // Articles index title
    let title = await page.title();
    expect(title).toContain("Articles");

    // Navigate to article detail
    await testId(page, "article-link-what-is-prerendering").click();
    await expect(testId(page, "article-detail")).toBeVisible();

    title = await page.title();
    expect(title).toContain("What is Pre-rendering?");

    // Navigate back to articles index
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
    await testId(page, "article-link-what-is-prerendering").click();
    await expect(testId(page, "article-title")).toHaveText(
      "What is Pre-rendering?"
    );

    // Browser back -> articles index
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
 * All handlers run live at request time. Loader freshness can be asserted.
 *
 * Skipped: include() + createPrerenderHandler fails manifest loading in dev
 * mode ("Route must be registered for articles.index"). This is a framework
 * bug — loadManifest does not find the route after handler execution when
 * the route is included via include() with a prerender handler.
 * Remove .skip once the framework handles this case.
 */
test.describe.skip("prerender-complex (dev)", () => {
  const f = useFixture({
    root: ".",
    mode: "dev",
  });

  // -- Layout --

  test("layout renders on direct visit", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/articles"));
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

  // -- Parallel slots --

  test("stats sidebar renders on index", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/articles"));
    await waitForHydration(page);

    await expect(testId(page, "articles-stats-sidebar")).toBeVisible();
    await expect(testId(page, "stats-rendered-at")).toBeVisible();
  });

  test("stats sidebar not present on article detail", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/articles/what-is-prerendering"));
    await waitForHydration(page);

    await expect(testId(page, "article-detail")).toBeVisible();
    await expect(testId(page, "articles-stats-sidebar")).not.toBeVisible();
  });

  // -- Loader freshness --

  test("loader timestamp is fresh on direct visit", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/articles"));
    await waitForHydration(page);

    const text = await testId(page, "stats-rendered-at").textContent();
    const match = text!.match(/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/);
    expect(match).toBeTruthy();

    const renderedAt = new Date(match![1]);
    const diffMs = Date.now() - renderedAt.getTime();
    // In dev mode, loader runs at request time — timestamp must be recent
    expect(diffMs).toBeLessThan(30_000);
  });

  test("loader re-executes on each navigation", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/articles"));
    await waitForHydration(page);

    const text1 = await testId(page, "stats-rendered-at").textContent();

    await testId(page, "nav-counter").click();
    await expect(testId(page, "counter-page")).toBeVisible();

    await testId(page, "nav-articles").click();
    await expect(testId(page, "articles-stats-sidebar")).toBeVisible();

    const text2 = await testId(page, "stats-rendered-at").textContent();

    // Loader runs fresh each time — timestamps must differ
    expect(text2).not.toEqual(text1);
  });

  // -- Navigation --

  test("navigate between articles without reload", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/articles"));
    await waitForHydration(page);

    await using __ = await expectNoReload(page);

    await testId(page, "article-link-what-is-prerendering").click();
    await expect(testId(page, "article-title")).toHaveText(
      "What is Pre-rendering?"
    );

    await page.locator("text=Back to Articles").click();
    await expect(testId(page, "articles-index")).toBeVisible();

    await testId(page, "article-link-static-params").click();
    await expect(testId(page, "article-title")).toHaveText(
      "Static Params with getParams"
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
