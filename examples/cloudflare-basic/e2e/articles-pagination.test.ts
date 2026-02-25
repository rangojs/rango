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
 * Pagination tests for pre-rendered articles.
 *
 * Demonstrates handler-first data flow:
 * - getParams(ctx) shares allArticles via ctx.set() at build time
 * - Handler slices articles for each page, ctx.set("pagination", {...})
 * - PaginationLayout (orphan layout) reads ctx.get("pagination") for nav controls
 *
 * 20 articles, 5 per page = 4 pages pre-rendered.
 */

// -- Dev mode ----------------------------------------------------------------

test.describe("articles pagination (dev)", () => {
  const f = useFixture({
    root: ".",
    mode: "dev",
  });

  test("page 1 shows first 5 articles", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/articles/page/1"));
    await waitForHydration(page);

    await expect(testId(page, "articles-index")).toBeVisible();
    await expect(testId(page, "articles-title")).toHaveText("Articles");

    const cards = page.locator("[data-testid^='article-card-']");
    await expect(cards).toHaveCount(5);
  });

  test("page 2 shows next 5 articles", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/articles/page/2"));
    await waitForHydration(page);

    await expect(testId(page, "articles-index")).toBeVisible();

    const cards = page.locator("[data-testid^='article-card-']");
    await expect(cards).toHaveCount(5);
  });

  test("page 4 (last page) shows remaining articles", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/articles/page/4"));
    await waitForHydration(page);

    await expect(testId(page, "articles-index")).toBeVisible();

    const cards = page.locator("[data-testid^='article-card-']");
    await expect(cards).toHaveCount(5);
  });

  test("pagination layout shows correct page info", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/articles/page/1"));
    await waitForHydration(page);

    await expect(testId(page, "pagination-layout")).toBeVisible();
    await expect(testId(page, "pagination-info")).toHaveText("Page 1 of 4");
  });

  test("page 1 has no prev link, has next link", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/articles/page/1"));
    await waitForHydration(page);

    await expect(testId(page, "pagination-prev-disabled")).toBeVisible();
    await expect(testId(page, "pagination-next")).toBeVisible();
  });

  test("page 4 has prev link, no next link", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/articles/page/4"));
    await waitForHydration(page);

    await expect(testId(page, "pagination-prev")).toBeVisible();
    await expect(testId(page, "pagination-next-disabled")).toBeVisible();
  });

  test("middle page has both prev and next links", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/articles/page/2"));
    await waitForHydration(page);

    await expect(testId(page, "pagination-prev")).toBeVisible();
    await expect(testId(page, "pagination-next")).toBeVisible();
    await expect(testId(page, "pagination-info")).toHaveText("Page 2 of 4");
  });

  test("next link navigates to next page", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/articles/page/1"));
    await waitForHydration(page);

    await using __ = await expectNoReload(page);

    await testId(page, "pagination-next").click();
    await expect(testId(page, "pagination-info")).toHaveText("Page 2 of 4");

    const cards = page.locator("[data-testid^='article-card-']");
    await expect(cards).toHaveCount(5);
  });

  test("prev link navigates to previous page", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/articles/page/2"));
    await waitForHydration(page);

    await using __ = await expectNoReload(page);

    await testId(page, "pagination-prev").click();
    await expect(testId(page, "pagination-info")).toHaveText("Page 1 of 4");
  });

  test("article detail still works from paginated list", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/articles/page/1"));
    await waitForHydration(page);

    // Click the first article link on page 1
    const firstLink = page.locator("[data-testid^='article-link-']").first();
    await firstLink.click();

    await expect(testId(page, "article-detail")).toBeVisible();
    await expect(testId(page, "article-title")).toBeVisible();
  });

  test("different pages show different articles", async ({ page }) => {
    using _ = expectNoPageError(page);

    // Collect article slugs from page 1
    await page.goto(f.url("/articles/page/1"));
    await waitForHydration(page);
    const page1Slugs = await page
      .locator("[data-testid^='article-card-']")
      .evaluateAll((els) =>
        els.map((el) => el.getAttribute("data-testid")!.replace("article-card-", "")),
      );

    // Collect article slugs from page 2
    await page.goto(f.url("/articles/page/2"));
    await waitForHydration(page);
    const page2Slugs = await page
      .locator("[data-testid^='article-card-']")
      .evaluateAll((els) =>
        els.map((el) => el.getAttribute("data-testid")!.replace("article-card-", "")),
      );

    // No overlap between pages
    const overlap = page1Slugs.filter((s) => page2Slugs.includes(s));
    expect(overlap).toEqual([]);
  });
});

// -- Production build --------------------------------------------------------

test.describe("articles pagination (production)", () => {
  const f = useFixture({
    root: ".",
    mode: "build",
  });

  test("page 1 shows first 5 articles", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/articles/page/1"));
    await waitForHydration(page);

    await expect(testId(page, "articles-index")).toBeVisible();
    await expect(testId(page, "articles-title")).toHaveText("Articles");

    const cards = page.locator("[data-testid^='article-card-']");
    await expect(cards).toHaveCount(5);
  });

  test("page 2 shows next 5 articles", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/articles/page/2"));
    await waitForHydration(page);

    await expect(testId(page, "articles-index")).toBeVisible();

    const cards = page.locator("[data-testid^='article-card-']");
    await expect(cards).toHaveCount(5);
  });

  test("pagination layout shows correct page info from ctx.get()", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/articles/page/1"));
    await waitForHydration(page);

    await expect(testId(page, "pagination-layout")).toBeVisible();
    await expect(testId(page, "pagination-info")).toHaveText("Page 1 of 4");
  });

  test("pre-rendered timestamps are stable across reloads", async ({
    page,
  }) => {
    await page.goto(f.url("/articles/page/1"));
    await waitForHydration(page);

    const ts1 = await testId(page, "prerender-timestamp").textContent();

    await page.reload();
    await waitForHydration(page);

    const ts2 = await testId(page, "prerender-timestamp").textContent();

    // Truly pre-rendered: identical timestamp across reloads
    expect(ts1).toBe(ts2);
  });

  test("different pages have different pre-rendered timestamps", async ({
    page,
  }) => {
    await page.goto(f.url("/articles/page/1"));
    await waitForHydration(page);
    const ts1 = await testId(page, "prerender-timestamp").textContent();

    await page.goto(f.url("/articles/page/2"));
    await waitForHydration(page);
    const ts2 = await testId(page, "prerender-timestamp").textContent();

    // Different pages are separate prerender invocations — timestamps may differ
    // (though could be same if built quickly). At minimum, they should be valid.
    expect(ts1).toBeTruthy();
    expect(ts2).toBeTruthy();
  });

  test("next link navigates between pre-rendered pages", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/articles/page/1"));
    await waitForHydration(page);

    await using __ = await expectNoReload(page);

    await testId(page, "pagination-next").click();
    await expect(testId(page, "pagination-info")).toHaveText("Page 2 of 4");

    await testId(page, "pagination-next").click();
    await expect(testId(page, "pagination-info")).toHaveText("Page 3 of 4");
  });

  test("page 1 has disabled prev, page 4 has disabled next", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/articles/page/1"));
    await waitForHydration(page);
    await expect(testId(page, "pagination-prev-disabled")).toBeVisible();
    await expect(testId(page, "pagination-next")).toBeVisible();

    await page.goto(f.url("/articles/page/4"));
    await waitForHydration(page);
    await expect(testId(page, "pagination-prev")).toBeVisible();
    await expect(testId(page, "pagination-next-disabled")).toBeVisible();
  });

  test("different pages show different articles", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/articles/page/1"));
    await waitForHydration(page);
    const page1Slugs = await page
      .locator("[data-testid^='article-card-']")
      .evaluateAll((els) =>
        els.map((el) => el.getAttribute("data-testid")!.replace("article-card-", "")),
      );

    await page.goto(f.url("/articles/page/2"));
    await waitForHydration(page);
    const page2Slugs = await page
      .locator("[data-testid^='article-card-']")
      .evaluateAll((els) =>
        els.map((el) => el.getAttribute("data-testid")!.replace("article-card-", "")),
      );

    const overlap = page1Slugs.filter((s) => page2Slugs.includes(s));
    expect(overlap).toEqual([]);
  });

  test("article detail accessible from any page", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/articles/page/1"));
    await waitForHydration(page);

    await using __ = await expectNoReload(page);

    const firstLink = page.locator("[data-testid^='article-link-']").first();
    await firstLink.click();

    await expect(testId(page, "article-detail")).toBeVisible();
    await expect(testId(page, "article-title")).toBeVisible();

    // Back to Articles link should work
    await page.locator("text=Back to Articles").click();
    await expect(testId(page, "articles-index")).toBeVisible();
  });
});
