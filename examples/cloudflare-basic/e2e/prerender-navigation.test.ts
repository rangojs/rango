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
test.describe("prerender navigation (build)", () => {
  const f = useFixture({
    root: ".",
    mode: "build",
  });

  test("blog sidebar visible when navigating from prerendered articles", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/articles"));
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
    await expect(testId(page, "blog-index")).toBeVisible();
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

    await page.goto(f.url("/articles"));
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

    await page.goto(f.url("/articles"));
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
});

test.describe("prerender navigation (dev)", () => {
  const f = useFixture({
    root: ".",
    mode: "dev",
  });

  test("blog sidebar visible when navigating from articles", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/articles"));
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

    // No fallback or missing segment warnings
    expect(warnings).toEqual([]);
  });

  test("navigating from articles preserves shared layout", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/articles"));
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
});
