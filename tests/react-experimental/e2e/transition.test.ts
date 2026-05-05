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

// Regression: handleNavigationEnd's scrollToTop branch used to defer via
// requestAnimationFrame. For navigations wrapped in a layout/route view
// transition, the rAF callback fired AFTER startViewTransition's snapshot
// capture — the live DOM scrolled but the captured snapshot was at the
// previous scroll position, leaving the user-facing page visually
// clamped at the source scrollY (often the new tree's max scroll on
// tall→short navs). scrollToTop now runs synchronously inside
// useLayoutEffect so the scroll lands before the snapshot.
test.describe("scroll-to-top on forward nav under VT (dev)", () => {
  const f = useFixture({
    root: ".",
    mode: "dev",
  });

  test("forward nav scrolls to top even when wrapped in a view transition", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await page.goto(f.url("/layout-tx-a"));
    await waitForHydration(page);
    await expect(testId(page, "layout-tx-a-page")).toBeVisible();

    // Scroll down on the long source page (filler in /layout-tx-a)
    await page.evaluate(() => window.scrollTo(0, 800));
    await expect
      .poll(async () => page.evaluate(() => window.scrollY))
      .toBe(800);

    // Forward to the short destination — VT fires (layout-level transition).
    // After commit, scrollY should be 0.
    await testId(page, "nav-layout-tx-b").click();
    await expect(page).toHaveURL(/\/layout-tx-b/);
    await expect(testId(page, "layout-tx-b-page")).toBeVisible();

    await expect.poll(async () => page.evaluate(() => window.scrollY)).toBe(0);
  });
});

test.describe("scroll-to-top on forward nav under VT (production)", () => {
  const f = useFixture({
    root: ".",
    mode: "build",
  });

  test("forward nav scrolls to top even when wrapped in a view transition", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await page.goto(f.url("/layout-tx-a"));
    await waitForHydration(page);
    await expect(testId(page, "layout-tx-a-page")).toBeVisible();

    await page.evaluate(() => window.scrollTo(0, 800));
    await expect
      .poll(async () => page.evaluate(() => window.scrollY))
      .toBe(800);

    await testId(page, "nav-layout-tx-b").click();
    await expect(page).toHaveURL(/\/layout-tx-b/);
    await expect(testId(page, "layout-tx-b-page")).toBeVisible();

    await expect.poll(async () => page.evaluate(() => window.scrollY)).toBe(0);
  });
});

test.describe("blog shared transitions (dev)", () => {
  const f = useFixture({
    root: ".",
    mode: "dev",
  });

  test("should render blog index on direct visit", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/blog"));
    await waitForHydration(page);

    await expect(testId(page, "blog-index-page")).toBeVisible();
    await expect(testId(page, "blog-index-title")).toHaveText(
      "The Latest News",
    );
  });

  test("should render blog detail on direct visit", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/blog/rsc-routing"));
    await waitForHydration(page);

    await expect(testId(page, "blog-detail-page")).toBeVisible();
    await expect(testId(page, "blog-detail-title")).toHaveText("RSC Routing");
  });

  test("should navigate from blog index to detail via card click", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/blog"));
    await waitForHydration(page);
    await expect(testId(page, "blog-index-page")).toBeVisible();

    // Click a card to navigate to detail
    await using __ = await expectNoReload(page);
    await testId(page, "blog-card-composable-caching")
      .locator("a")
      .first()
      .click();
    await expect(page).toHaveURL(/\/blog\/composable-caching/);
    await expect(testId(page, "blog-detail-page")).toBeVisible();
    await expect(testId(page, "blog-detail-title")).toHaveText(
      "Composable Caching",
    );
  });

  test("should navigate back from detail to index", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/blog"));
    await waitForHydration(page);

    // Go to detail
    await testId(page, "blog-card-view-transitions")
      .locator("a")
      .first()
      .click();
    await expect(page).toHaveURL(/\/blog\/view-transitions/);
    await expect(testId(page, "blog-detail-title")).toHaveText(
      "View Transitions",
    );

    // Click back link
    await using __ = await expectNoReload(page);
    await testId(page, "blog-back").click();
    await expect(page).toHaveURL(/\/blog$/);
    await expect(testId(page, "blog-index-page")).toBeVisible();
  });

  test("should navigate from home to blog", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/"));
    await waitForHydration(page);

    await using __ = await expectNoReload(page);
    await testId(page, "nav-blog").click();
    await expect(page).toHaveURL(/\/blog$/);
    await expect(testId(page, "blog-index-page")).toBeVisible();
  });
});

test.describe("cards shared transitions (dev)", () => {
  const f = useFixture({
    root: ".",
    mode: "dev",
  });

  test("should render card index on direct visit", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/cards"));
    await waitForHydration(page);

    await expect(testId(page, "card-index-page")).toBeVisible();
  });

  test("should render card detail on direct visit", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/cards/florence"));
    await waitForHydration(page);

    await expect(testId(page, "card-detail-page")).toBeVisible();
    await expect(testId(page, "card-detail-title")).toHaveText("Spots");
  });

  test("should navigate from card index to detail via card click", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/cards"));
    await waitForHydration(page);
    await expect(testId(page, "card-index-page")).toBeVisible();

    // Click a card to navigate to detail
    await using __ = await expectNoReload(page);
    await testId(page, "card-barcelona").click();
    await expect(page).toHaveURL(/\/cards\/barcelona/);
    await expect(testId(page, "card-detail-page")).toBeVisible();
  });

  test("should navigate back from detail to index", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/cards/xian"));
    await waitForHydration(page);
    await expect(testId(page, "card-detail-page")).toBeVisible();

    // Click back arrow
    await using __ = await expectNoReload(page);
    await testId(page, "card-back").click();
    await expect(page).toHaveURL(/\/cards$/);
    await expect(testId(page, "card-index-page")).toBeVisible();
  });

  test("should navigate from home to cards", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/"));
    await waitForHydration(page);

    await using __ = await expectNoReload(page);
    await testId(page, "nav-cards").click();
    await expect(page).toHaveURL(/\/cards$/);
    await expect(testId(page, "card-index-page")).toBeVisible();
  });
});

test.describe("prerender/static transitions (dev)", () => {
  const f = useFixture({
    root: ".",
    mode: "dev",
  });

  test("should navigate from home to static page without reload", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/"));
    await waitForHydration(page);

    await using __ = await expectNoReload(page);
    await testId(page, "nav-static").click();
    await expect(page).toHaveURL(/\/static/);
    await expect(testId(page, "static-page")).toBeVisible();
    await expect(testId(page, "static-title")).toHaveText("Static Page");
  });

  test("should navigate from home to prerender page without reload", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/"));
    await waitForHydration(page);

    await using __ = await expectNoReload(page);
    await testId(page, "nav-prerender").click();
    await expect(page).toHaveURL(/\/prerender/);
    await expect(testId(page, "prerender-page")).toBeVisible();
    await expect(testId(page, "prerender-title")).toHaveText(
      "Pre-rendered Page",
    );
  });

  test("should navigate between static and prerender without reload", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/static"));
    await waitForHydration(page);
    await expect(testId(page, "static-page")).toBeVisible();

    await using __ = await expectNoReload(page);
    await testId(page, "nav-prerender").click();
    await expect(page).toHaveURL(/\/prerender/);
    await expect(testId(page, "prerender-page")).toBeVisible();
  });

  test("should handle back navigation between static and prerender", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/static"));
    await waitForHydration(page);
    await expect(testId(page, "static-page")).toBeVisible();

    // Navigate to prerender
    await testId(page, "nav-prerender").click();
    await expect(page).toHaveURL(/\/prerender/);
    await expect(testId(page, "prerender-page")).toBeVisible();

    // Go back to static
    await page.goBack();
    await expect(page).toHaveURL(/\/static/);
    await expect(testId(page, "static-page")).toBeVisible();
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

  test("should render blog index in production", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/blog"));
    await waitForHydration(page);

    await expect(testId(page, "blog-index-page")).toBeVisible();
    await expect(testId(page, "blog-index-title")).toHaveText(
      "The Latest News",
    );
  });

  test("should navigate from blog to detail in production", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/blog"));
    await waitForHydration(page);

    await using __ = await expectNoReload(page);
    await testId(page, "blog-card-rsc-routing").locator("a").first().click();
    await expect(page).toHaveURL(/\/blog\/rsc-routing/);
    await expect(testId(page, "blog-detail-page")).toBeVisible();
    await expect(testId(page, "blog-detail-title")).toHaveText("RSC Routing");
  });

  test("should render card index in production", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/cards"));
    await waitForHydration(page);

    await expect(testId(page, "card-index-page")).toBeVisible();
  });

  test("should navigate from cards to detail in production", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/cards"));
    await waitForHydration(page);

    await using __ = await expectNoReload(page);
    await testId(page, "card-florence").click();
    await expect(page).toHaveURL(/\/cards\/florence/);
    await expect(testId(page, "card-detail-page")).toBeVisible();
  });

  test("should navigate to static page without reload in production", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/"));
    await waitForHydration(page);

    await using __ = await expectNoReload(page);
    await testId(page, "nav-static").click();
    await expect(page).toHaveURL(/\/static/);
    await expect(testId(page, "static-page")).toBeVisible();
  });

  test("should navigate to prerender page without reload in production", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/"));
    await waitForHydration(page);

    await using __ = await expectNoReload(page);
    await testId(page, "nav-prerender").click();
    await expect(page).toHaveURL(/\/prerender/);
    await expect(testId(page, "prerender-page")).toBeVisible();
  });

  test("should navigate between static and prerender in production", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/static"));
    await waitForHydration(page);

    await using __ = await expectNoReload(page);
    await testId(page, "nav-prerender").click();
    await expect(page).toHaveURL(/\/prerender/);
    await expect(testId(page, "prerender-page")).toBeVisible();
  });
});
