import { expect, test, type Page } from "@playwright/test";
import { useFixture } from "./fixture";
import {
  waitForHydration,
  expectNoPageError,
  expectNoReload,
  testId,
} from "./helper";

test.describe.configure({ mode: "serial" });

/**
 * Paging from /articles/page/1 to /articles/page/2 changes the route params
 * and holds ArticlesLayout; both pages are served from their bake. The layout
 * stays as the first page left it, as a live route keeps it: page 2's
 * responses (its prefetch included) do not carry it, and the page keeps the
 * same element with the same render stamp. The bake used to send it again
 * from page 2's artifact when the params changed (cache-lookup.ts
 * storedEntrySends); a build can bake both pages' layout with one stamp, so
 * only the response tells it apart there.
 */
async function expectArticlesLayoutHeld(page: Page, url: string) {
  const pageTwo: Promise<string>[] = [];
  page.on("response", (response) => {
    const target = new URL(response.url());
    if (
      target.pathname === "/articles/page/2" &&
      target.searchParams.has("_rsc_partial")
    ) {
      // A prefetch the router dropped may have no body to read.
      pageTwo.push(response.text().catch(() => ""));
    }
  });
  await page.goto(url);
  await waitForHydration(page);
  const stamp = await testId(page, "layout-rendered-at").textContent();
  await testId(page, "articles-layout").evaluate((el) => {
    (el as HTMLElement & { __held?: boolean }).__held = true;
  });

  await using _ = await expectNoReload(page);
  await testId(page, "pagination-next").click();
  await expect(testId(page, "pagination-info")).toContainText("Page 2 of");

  await expect(testId(page, "layout-rendered-at")).toHaveText(stamp!);
  expect(
    await testId(page, "articles-layout").evaluate(
      (el) => (el as HTMLElement & { __held?: boolean }).__held === true,
    ),
  ).toBe(true);
  const bodies = await Promise.all(pageTwo);
  expect(bodies.some((body) => body.length > 0)).toBe(true);
  for (const body of bodies) {
    expect(body).not.toContain("Layout rendered at");
  }
}

/**
 * Tests for navigating AWAY from pre-rendered pages.
 *
 * Pre-rendered pages inside include() scopes generate segment IDs at build time.
 * When navigating from a pre-rendered page to a non-pre-rendered page, the
 * segment IDs must be compatible so that the partial update system can reuse
 * shared segments (like NavLayout) instead of doing a full remount.
 *
 * Symptoms of the bug:
 * - Blog sidebar (parallel segment) missing after navigating from /articles
 * - Loading indicators not showing when navigating to slow routes
 * - All segments replaced instead of partial update
 */
test.describe("prerender navigation (production)", () => {
  const f = useFixture({
    root: ".",
    mode: "build",
  });

  test("blog sidebar visible when navigating from prerendered articles", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/articles/page/1"));
    await waitForHydration(page);
    await expect(testId(page, "articles-index")).toBeVisible();

    const warnings: string[] = [];
    page.on("console", (msg) => {
      const text = msg.text();
      if (
        text.includes("Full update (fallback)") ||
        text.includes("Missing segment:")
      ) {
        warnings.push(text);
      }
    });

    await using __ = await expectNoReload(page);

    // Navigate to blog — blog sidebar (parallel @sidebar) should appear
    await testId(page, "nav-blog").click();
    await expect(testId(page, "blog-index")).toBeVisible({ timeout: 10000 });
    await expect(testId(page, "blog-title")).toHaveText("Blog");

    // The parallel @sidebar must be rendered
    await expect(testId(page, "blog-sidebar")).toBeVisible({ timeout: 10000 });

    // No fallback or missing segment warnings
    expect(warnings).toEqual([]);
  });

  test("blog sidebar visible on direct visit (control)", async ({ page }) => {
    using _ = expectNoPageError(page);

    // Direct visit to /blog should always show the sidebar
    await page.goto(f.url("/blog"));
    await waitForHydration(page);

    await expect(testId(page, "blog-index")).toBeVisible();
    await expect(testId(page, "blog-sidebar")).toBeVisible({ timeout: 10000 });
  });

  test("navigating from prerendered to non-prerendered preserves shared layout", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/articles/page/1"));
    await waitForHydration(page);

    // Capture warnings about segment mismatches
    const missingSegments: string[] = [];
    page.on("console", (msg) => {
      const text = msg.text();
      if (text.includes("Missing segment:")) {
        missingSegments.push(text);
      }
    });

    await using __ = await expectNoReload(page);

    // Navigate to about page (non-prerendered, shares NavLayout)
    await testId(page, "nav-about").click();
    await expect(testId(page, "about-page")).toBeVisible();

    // NavLayout should be preserved, no missing segments
    await expect(testId(page, "nav")).toBeVisible();
    expect(missingSegments).toEqual([]);
  });

  test("navigating from prerendered to another prerendered route", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/articles/page/1"));
    await waitForHydration(page);

    const warnings: string[] = [];
    page.on("console", (msg) => {
      const text = msg.text();
      if (
        text.includes("Full update (fallback)") ||
        text.includes("Missing segment:")
      ) {
        warnings.push(text);
      }
    });

    await using __ = await expectNoReload(page);

    // Navigate to releases (also prerendered via include())
    await testId(page, "nav-releases").click();
    await expect(testId(page, "releases-page")).toBeVisible();

    expect(warnings).toEqual([]);
  });

  test("paging between prerendered articles keeps the held layout", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await expectArticlesLayoutHeld(page, f.url("/articles/page/1"));
  });
});

test.describe("prerender navigation (dev)", () => {
  const f = useFixture({
    root: ".",
    mode: "dev",
  });

  // TODO: flaky in serial dev mode — partial navigation from articles to
  // blog falls back to full reload. Passes in isolation and production.
  // Root cause is dev-mode RSC stream compilation timing during serial runs.
  test.fixme("blog sidebar visible when navigating from articles", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // Warm up the dev server so blog modules are compiled before the
    // timed navigation.  Without this Vite may still be compiling blog
    // code when the client navigates, causing an RSC stream timeout and
    // a full-page reload instead of a partial update.
    await page.goto(f.url("/blog"));
    await waitForHydration(page);

    await page.goto(f.url("/articles/page/1"));
    await waitForHydration(page);
    await expect(testId(page, "articles-index")).toBeVisible();

    const warnings: string[] = [];
    page.on("console", (msg) => {
      const text = msg.text();
      if (
        text.includes("Full update (fallback)") ||
        text.includes("Missing segment:")
      ) {
        warnings.push(text);
      }
    });

    await using __ = await expectNoReload(page);

    // Navigate to blog — sidebar (parallel segment) should appear
    await testId(page, "nav-blog").click();
    await expect(testId(page, "blog-index")).toBeVisible();
    await expect(testId(page, "blog-title")).toHaveText("Blog");

    // The parallel @sidebar must be rendered
    await expect(testId(page, "blog-sidebar")).toBeVisible({ timeout: 10000 });
  });

  test("navigating from articles preserves shared layout", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/articles/page/1"));
    await waitForHydration(page);

    const missingSegments: string[] = [];
    page.on("console", (msg) => {
      const text = msg.text();
      if (text.includes("Missing segment:")) {
        missingSegments.push(text);
      }
    });

    await using __ = await expectNoReload(page);

    await testId(page, "nav-about").click();
    await expect(testId(page, "about-page")).toBeVisible();
    await expect(testId(page, "nav")).toBeVisible();
    expect(missingSegments).toEqual([]);
  });

  test("paging between prerendered articles keeps the held layout", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await expectArticlesLayoutHeld(page, f.url("/articles/page/1"));
  });
});
