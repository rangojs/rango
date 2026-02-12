import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import {
  waitForHydration,
  expectNoPageError,
  testId,
  expectNoReload,
} from "./helper";

test.describe.configure({ mode: "serial" });

test.describe("blog with CF cache", () => {
  const f = useFixture({
    root: ".",
    mode: "dev",
  });

  test("should render blog index with posts list", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/blog"));
    await waitForHydration(page);

    // Blog layout should be visible
    await expect(testId(page, "blog-layout")).toBeVisible();

    // Blog index content
    await expect(testId(page, "blog-title")).toHaveText("Blog");
    await expect(testId(page, "blog-posts-list")).toBeVisible();

    // Should show all 3 blog posts
    await expect(testId(page, "blog-post-getting-started-with-rsc")).toBeVisible();
    await expect(testId(page, "blog-post-cloudflare-workers-deployment")).toBeVisible();
    await expect(testId(page, "blog-post-understanding-caching-strategies")).toBeVisible();
  });

  test("should stream sidebar with skeleton then content", async ({ page }) => {
    using _ = expectNoPageError(page);

    // Navigate fresh to blog page
    await page.goto(f.url("/blog"));

    // Sidebar skeleton should appear first (streaming)
    // Note: May be too fast to catch in dev mode, so we check either skeleton or final content
    const skeletonOrContent = page.locator(
      '[data-testid="sidebar-skeleton"], [data-testid="blog-sidebar"]'
    );
    await expect(skeletonOrContent.first()).toBeVisible({ timeout: 5000 });

    // Wait for sidebar to fully load
    await expect(testId(page, "blog-sidebar")).toBeVisible({ timeout: 10000 });

    // Sidebar should show recent posts
    await expect(testId(page, "sidebar-link-getting-started-with-rsc")).toBeVisible();
    await expect(testId(page, "sidebar-link-cloudflare-workers-deployment")).toBeVisible();

    // Sidebar should show popular tags
    await expect(testId(page, "sidebar-tag-react")).toBeVisible();
    await expect(testId(page, "sidebar-tag-cloudflare")).toBeVisible();

    // Sidebar should show rendered timestamp
    await expect(testId(page, "sidebar-rendered-at")).toBeVisible();
  });

  test("should navigate to blog post detail page", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/blog"));
    await waitForHydration(page);

    // Wait for sidebar to load (streaming complete)
    await expect(testId(page, "blog-sidebar")).toBeVisible({ timeout: 10000 });

    await using __ = await expectNoReload(page);

    // Click on first blog post link
    await testId(page, "blog-link-getting-started-with-rsc").click();

    // Should navigate to blog post detail
    await expect(page).toHaveURL(/\/blog\/getting-started-with-rsc/);
    await expect(testId(page, "blog-post-detail")).toBeVisible();
    await expect(testId(page, "post-title")).toHaveText(
      "Getting Started with React Server Components"
    );
    await expect(testId(page, "post-author")).toHaveText("RSC Team");
    await expect(testId(page, "post-content")).toContainText("React Server Components");
  });

  test("should preserve sidebar during navigation to post", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/blog"));
    await waitForHydration(page);

    // Wait for sidebar to load
    await expect(testId(page, "blog-sidebar")).toBeVisible({ timeout: 10000 });

    // Get sidebar timestamp before navigation
    const sidebarTimeBefore = await testId(page, "sidebar-rendered-at").textContent();

    await using __ = await expectNoReload(page);

    // Navigate to post
    await testId(page, "blog-link-cloudflare-workers-deployment").click();
    await expect(testId(page, "blog-post-detail")).toBeVisible();

    // Sidebar should still be visible
    await expect(testId(page, "blog-sidebar")).toBeVisible();

    // Sidebar timestamp should be preserved (same as before - from cache)
    const sidebarTimeAfter = await testId(page, "sidebar-rendered-at").textContent();
    expect(sidebarTimeBefore).toBe(sidebarTimeAfter);
  });

  test("should render blog post directly via URL", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/blog/understanding-caching-strategies"));
    await waitForHydration(page);

    // Should render post detail
    await expect(testId(page, "blog-post-detail")).toBeVisible();
    await expect(testId(page, "post-title")).toHaveText(
      "Understanding RSC Caching Strategies"
    );
    await expect(testId(page, "post-content")).toContainText("Caching is crucial");

    // Sidebar should also load
    await expect(testId(page, "blog-sidebar")).toBeVisible({ timeout: 10000 });
  });

  test("should navigate back to blog index from post", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/blog/getting-started-with-rsc"));
    await waitForHydration(page);

    // Wait for full page load including sidebar
    await expect(testId(page, "blog-sidebar")).toBeVisible({ timeout: 10000 });

    await using __ = await expectNoReload(page);

    // Click back link
    await page.click('a:has-text("Back to Blog")');

    // Should navigate back to index
    await expect(page).toHaveURL(/\/blog$/);
    await expect(testId(page, "blog-index")).toBeVisible();
    await expect(testId(page, "blog-title")).toHaveText("Blog");
  });

  test("should show cache info timestamp", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/blog"));
    await waitForHydration(page);

    // Cache info should show rendered timestamp
    await expect(testId(page, "cache-info")).toContainText("Rendered at:");
    await expect(testId(page, "cache-info")).toContainText("TTL=60s");
  });

  test("sidebar links should navigate to posts", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/blog"));
    await waitForHydration(page);

    // Wait for sidebar
    await expect(testId(page, "blog-sidebar")).toBeVisible({ timeout: 10000 });

    await using __ = await expectNoReload(page);

    // Click sidebar link
    await testId(page, "sidebar-link-cloudflare-workers-deployment").click();

    // Should navigate to that post
    await expect(page).toHaveURL(/\/blog\/cloudflare-workers-deployment/);
    await expect(testId(page, "post-title")).toHaveText(
      "Deploying RSC to Cloudflare Workers"
    );
  });
});

test.describe("proactive-caching", () => {
  const f = useFixture({
    root: ".",
    mode: "dev",
    isolatedServer: true,
  });

  test("proactive caching triggers when navigating within cached layout", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // Step 1: Document request to item-a
    const beforeFirstVisit = f.proc().stdout();
    await page.goto(f.url("/proactive-cache/item-a"));
    await waitForHydration(page);
    const afterFirstVisit = f.proc().stdout();
    const firstVisitLogs = afterFirstVisit.slice(beforeFirstVisit.length);

    // Verify layout and content rendered
    await expect(testId(page, "proactive-cache-layout")).toBeVisible();
    await expect(testId(page, "proactive-item-a-page")).toBeVisible();

    // Should have cache interaction (MISS on fresh cache, HIT on warmed cache)
    expect(firstVisitLogs).toContain("[CacheScope]");

    // Step 2: Partial navigation to item-b (within same layout)
    // This triggers proactive caching because layout has null component
    // (unless doc entry already exists from previous run, in which case it skips)
    const beforePartialNav = f.proc().stdout();
    await testId(page, "proactive-nav-b").click();
    await expect(testId(page, "proactive-item-b-page")).toBeVisible();

    // Give proactive caching time to complete in background
    await page.waitForTimeout(500);

    const afterPartialNav = f.proc().stdout();
    const partialNavLogs = afterPartialNav.slice(beforePartialNav.length);

    // Check for valid cache interaction during partial navigation:
    // - "Proactive caching" = we rendered null segments in background
    // - "HIT: partial:" = partial cache hit, served from cache (already has complete segments)
    // Both are valid outcomes depending on cache state
    const proactiveTriggered = partialNavLogs.includes("Proactive caching");
    const partialCacheHit = partialNavLogs.includes("HIT: partial:");
    expect(proactiveTriggered || partialCacheHit).toBe(true);
  });

  test("layout renders correctly after proactive caching", async ({ page }) => {
    using _ = expectNoPageError(page);

    // Step 1: Document request to index (populates cache)
    await page.goto(f.url("/proactive-cache"));
    await waitForHydration(page);
    await expect(testId(page, "proactive-cache-layout")).toBeVisible();
    await expect(testId(page, "proactive-index-page")).toBeVisible();

    // Step 2: Partial nav to item-a (triggers proactive caching for layout)
    await testId(page, "proactive-nav-a").click();
    await expect(testId(page, "proactive-item-a-page")).toBeVisible();

    // Wait for proactive caching to complete
    await page.waitForTimeout(500);

    // Step 3: Navigate to home (outside cached layout)
    await testId(page, "proactive-back-home").click();
    await waitForHydration(page);

    // Step 4: Hard navigate to item-a
    // Should use cached layout from proactive caching (not broken null components)
    await page.goto(f.url("/proactive-cache/item-a"));
    await waitForHydration(page);

    // Layout should be visible and functional
    await expect(testId(page, "proactive-cache-layout")).toBeVisible();
    await expect(testId(page, "proactive-layout-title")).toHaveText(
      "Proactive Cache Layout"
    );
    await expect(testId(page, "proactive-item-a-page")).toBeVisible();

    // Navigation within layout should work
    await testId(page, "proactive-nav-b").click();
    await expect(testId(page, "proactive-item-b-page")).toBeVisible();
  });
});
