import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError } from "./helper";

/**
 * Tests that validate caching behavior by checking server logs.
 * The test-app has blog routes wrapped in cache({ ttl: 600 }) for testing.
 *
 * Cache log format:
 * - [CacheScope] MISS: doc:/blog - Cache miss for document request
 * - [CacheScope] Cached: doc:/blog (...) ttl=600s - Cache write confirmation
 * - [CacheScope] HIT: doc:/blog (...) - Cache hit for subsequent request
 * - [CacheScope] STALE: doc:/blog (...) - Stale response (SWR revalidation triggered)
 */

test.describe("cache-server-logs", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
    isolatedServer: true,
  });

  /**
   * Helper to get server stdout and find cache log entries
   */
  function getCacheLogs(stdout: string): {
    misses: string[];
    hits: string[];
    cached: string[];
    stale: string[];
  } {
    const lines = stdout.split("\n");
    return {
      misses: lines.filter((line) => line.includes("[CacheScope] MISS:")),
      hits: lines.filter((line) => line.includes("[CacheScope] HIT:")),
      cached: lines.filter((line) => line.includes("[CacheScope] Cached:")),
      stale: lines.filter((line) => line.includes("[CacheScope] STALE:")),
    };
  }

  test("document request should cache on first visit and hit on second", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // Get initial stdout length to find new logs
    const initialStdout = f.proc().stdout();
    const initialLength = initialStdout.length;

    // First visit - should be a cache miss
    await page.goto(f.url("/blog"));
    await waitForHydration(page);

    // Verify page content
    await expect(page.getByTestId("blog-title")).toHaveText("Blog");

    // Wait a bit for cache write to complete (async via waitUntil)
    await page.waitForTimeout(500);

    // Get new logs since first request
    const afterFirstStdout = f.proc().stdout();
    const firstLogs = getCacheLogs(afterFirstStdout.substring(initialLength));

    // Should have exactly one MISS for doc:/blog
    expect(
      firstLogs.misses.some((log) => log.includes("doc:/blog"))
    ).toBeTruthy();

    // Should have a Cached log after async write
    expect(
      firstLogs.cached.some((log) => log.includes("doc:/blog"))
    ).toBeTruthy();

    // Navigate away
    await page.goto(f.url("/"));
    await waitForHydration(page);

    // Record stdout length before second blog visit
    const beforeSecondStdout = f.proc().stdout();
    const beforeSecondLength = beforeSecondStdout.length;

    // Second visit - should be a cache hit
    await page.goto(f.url("/blog"));
    await waitForHydration(page);

    // Verify page content still correct
    await expect(page.getByTestId("blog-title")).toHaveText("Blog");

    // Get logs from second request
    const afterSecondStdout = f.proc().stdout();
    const secondLogs = getCacheLogs(afterSecondStdout.substring(beforeSecondLength));

    // Should have a HIT for doc:/blog (not MISS)
    expect(
      secondLogs.hits.some((log) => log.includes("doc:/blog"))
    ).toBeTruthy();
    expect(
      secondLogs.misses.some((log) => log.includes("doc:/blog"))
    ).toBeFalsy();
  });

  test("partial navigation should use different cache key", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // Start at home page
    await page.goto(f.url("/"));
    await waitForHydration(page);

    // Get stdout length before navigation
    const beforeNavStdout = f.proc().stdout();
    const beforeNavLength = beforeNavStdout.length;

    // Client-side navigate to blog (partial request)
    await page.getByTestId("link-status-blog").click();
    await waitForHydration(page);

    // Verify navigation completed
    await expect(page.getByTestId("blog-title")).toHaveText("Blog");

    // Wait for cache write
    await page.waitForTimeout(500);

    // Check logs - should see partial:/blog MISS
    const afterNavStdout = f.proc().stdout();
    const navLogs = getCacheLogs(afterNavStdout.substring(beforeNavLength));

    // Should have MISS for partial:/blog
    expect(
      navLogs.misses.some((log) => log.includes("partial:/blog"))
    ).toBeTruthy();

    // Should have Cached for partial:/blog
    expect(
      navLogs.cached.some((log) => log.includes("partial:/blog"))
    ).toBeTruthy();

    // Navigate back to home
    await page.getByTestId("back-link").click();
    await waitForHydration(page);

    // Record stdout before second navigation
    const beforeSecondNav = f.proc().stdout();
    const beforeSecondNavLen = beforeSecondNav.length;

    // Navigate to blog again (should be cache hit)
    await page.getByTestId("link-status-blog").click();
    await waitForHydration(page);

    await expect(page.getByTestId("blog-title")).toHaveText("Blog");

    // Check for cache hit
    const afterSecondNav = f.proc().stdout();
    const secondNavLogs = getCacheLogs(afterSecondNav.substring(beforeSecondNavLen));

    expect(
      secondNavLogs.hits.some((log) => log.includes("partial:/blog"))
    ).toBeTruthy();
  });

  test("blog post with params should cache with params in key", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    const initialStdout = f.proc().stdout();
    const initialLength = initialStdout.length;

    // Visit blog post with param
    await page.goto(f.url("/blog/post-1"));
    await waitForHydration(page);

    await expect(page.getByTestId("blog-post-title")).toHaveText("Post: post-1");

    // Wait for cache write
    await page.waitForTimeout(500);

    const afterFirstStdout = f.proc().stdout();
    const firstLogs = getCacheLogs(afterFirstStdout.substring(initialLength));

    // Should have MISS for doc:/blog/post-1 with params
    expect(
      firstLogs.misses.some((log) => log.includes("doc:/blog/post-1") || log.includes("postId=post-1"))
    ).toBeTruthy();

    // Different post should have its own cache entry
    const beforeSecondPost = f.proc().stdout();
    const beforeSecondLen = beforeSecondPost.length;

    await page.goto(f.url("/blog/post-2"));
    await waitForHydration(page);

    await expect(page.getByTestId("blog-post-title")).toHaveText("Post: post-2");

    const afterSecondPost = f.proc().stdout();
    const secondLogs = getCacheLogs(afterSecondPost.substring(beforeSecondLen));

    // Should be a MISS (different cache key due to different param)
    expect(
      secondLogs.misses.some((log) => log.includes("doc:/blog/post-2") || log.includes("postId=post-2"))
    ).toBeTruthy();

    // Going back to post-1 should be a HIT
    const beforeThirdPost = f.proc().stdout();
    const beforeThirdLen = beforeThirdPost.length;

    await page.goto(f.url("/blog/post-1"));
    await waitForHydration(page);

    const afterThirdPost = f.proc().stdout();
    const thirdLogs = getCacheLogs(afterThirdPost.substring(beforeThirdLen));

    expect(
      thirdLogs.hits.some((log) => log.includes("doc:/blog/post-1") || log.includes("postId=post-1"))
    ).toBeTruthy();
  });

  test("__no_cache query param should bypass cache", async ({ page }) => {
    using _ = expectNoPageError(page);

    // First, populate the cache
    await page.goto(f.url("/blog"));
    await waitForHydration(page);
    await page.waitForTimeout(500);

    // Navigate away and back to verify cache is working
    await page.goto(f.url("/"));
    await waitForHydration(page);

    // Now request with __no_cache - should bypass
    const beforeBypass = f.proc().stdout();
    const beforeBypassLen = beforeBypass.length;

    await page.goto(f.url("/blog?__no_cache"));
    await waitForHydration(page);

    await expect(page.getByTestId("blog-title")).toHaveText("Blog");

    const afterBypass = f.proc().stdout();
    const bypassLogs = getCacheLogs(afterBypass.substring(beforeBypassLen));

    // Should not have any cache logs (cache is disabled)
    expect(bypassLogs.hits.length).toBe(0);
    expect(bypassLogs.misses.length).toBe(0);
  });
});

test.describe("cache-loader-behavior", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
    isolatedServer: true,
  });

  test("non-cached loader should run on every request (default behavior)", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // First visit - loader runs, count should be 1
    await page.goto(f.url("/cache-test/non-cached-loader"));
    await waitForHydration(page);

    const firstCount = await page.getByTestId("loader-count").textContent();
    expect(firstCount).toContain("1");

    // Navigate away
    await page.goto(f.url("/"));
    await waitForHydration(page);

    // Second visit - loader should run again, count should increase
    await page.goto(f.url("/cache-test/non-cached-loader"));
    await waitForHydration(page);

    const secondCount = await page.getByTestId("loader-count").textContent();
    expect(secondCount).toContain("2");

    // The loadedAt should be different (new timestamp)
    // Loaders are NOT cached by default - they run fresh every time
  });

  test("loaders are excluded from route-level caching by design", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // Even with cache() wrapper on the loader, loaders run fresh by design
    // This is intentional - loaders can have their own cache() config but
    // are excluded from the route segment cache to ensure data freshness

    // First visit
    await page.goto(f.url("/cache-test/cached-loader"));
    await waitForHydration(page);

    const firstCount = await page.getByTestId("loader-count").textContent();
    const firstLoadedAt = await page.getByTestId("loaded-at").textContent();

    // Navigate away
    await page.goto(f.url("/"));
    await waitForHydration(page);

    // Second visit - loader should still run (excluded from cache)
    await page.goto(f.url("/cache-test/cached-loader"));
    await waitForHydration(page);

    const secondCount = await page.getByTestId("loader-count").textContent();
    const secondLoadedAt = await page.getByTestId("loaded-at").textContent();

    // Count should increase (loader ran again)
    expect(secondCount).not.toBe(firstCount);

    // loadedAt should be different (fresh data)
    expect(secondLoadedAt).not.toBe(firstLoadedAt);
  });
});

test.describe("cache-intercept-routes", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
    isolatedServer: true,
  });

  /**
   * Helper to get server stdout and find cache log entries
   */
  function getCacheLogs(stdout: string): {
    misses: string[];
    hits: string[];
    cached: string[];
    stale: string[];
  } {
    const lines = stdout.split("\n");
    return {
      misses: lines.filter((line) => line.includes("[CacheScope] MISS:")),
      hits: lines.filter((line) => line.includes("[CacheScope] HIT:")),
      cached: lines.filter((line) => line.includes("[CacheScope] Cached:")),
      stale: lines.filter((line) => line.includes("[CacheScope] STALE:")),
    };
  }

  test("intercept navigation should use intercept: cache key prefix", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // Start at the cache intercept index page
    await page.goto(f.url("/cache-test/intercept"));
    await waitForHydration(page);

    // Verify we're on the index
    await expect(page.getByTestId("cache-intercept-index")).toBeVisible();

    // Get stdout before clicking link (intercept navigation)
    const beforeInterceptStdout = f.proc().stdout();
    const beforeInterceptLen = beforeInterceptStdout.length;

    // Click link - this triggers intercept (modal opens)
    await page.getByTestId("cache-intercept-link-a").click();
    await waitForHydration(page);

    // Wait for modal to appear
    await expect(page.getByTestId("cache-test-modal")).toBeVisible();
    await expect(page.getByTestId("cache-test-modal-indicator")).toHaveText("Cache Test Intercept");

    // Wait for cache write
    await page.waitForTimeout(500);

    // Check logs - should see intercept: prefix in cache key
    const afterInterceptStdout = f.proc().stdout();
    const interceptLogs = getCacheLogs(afterInterceptStdout.substring(beforeInterceptLen));

    // Should have MISS for intercept:
    expect(
      interceptLogs.misses.some((log) => log.includes("intercept:"))
    ).toBeTruthy();

    // Should have Cached for intercept:
    expect(
      interceptLogs.cached.some((log) => log.includes("intercept:"))
    ).toBeTruthy();
  });

  test("intercept cache should be separate from document cache", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // First, do a document request to the detail page (direct navigation)
    await page.goto(f.url("/cache-test/intercept/item-b"));
    await waitForHydration(page);

    // Verify it's the full detail page (not modal)
    await expect(page.getByTestId("cache-intercept-detail")).toBeVisible();

    // Wait for cache write - this caches doc:/cache-test/intercept/item-b
    await page.waitForTimeout(500);

    // Now go to intercept index and do intercept navigation to item-b
    await page.goto(f.url("/cache-test/intercept"));
    await waitForHydration(page);

    const beforeInterceptStdout = f.proc().stdout();
    const beforeInterceptLen = beforeInterceptStdout.length;

    // Click item-b link - intercept navigation
    await page.getByTestId("cache-intercept-link-b").click();
    await waitForHydration(page);

    // Should show modal (intercept)
    await expect(page.getByTestId("cache-test-modal")).toBeVisible();

    // Wait for cache write
    await page.waitForTimeout(500);

    // Check logs - should be a MISS for intercept: (separate cache from doc:)
    const afterInterceptStdout = f.proc().stdout();
    const interceptLogs = getCacheLogs(afterInterceptStdout.substring(beforeInterceptLen));

    // Should be a MISS because intercept cache is separate from doc cache
    expect(
      interceptLogs.misses.some((log) => log.includes("intercept:"))
    ).toBeTruthy();
  });

  test("intercept cache hit on second navigation", async ({ page }) => {
    using _ = expectNoPageError(page);

    // Start at intercept index
    await page.goto(f.url("/cache-test/intercept"));
    await waitForHydration(page);

    // First intercept navigation
    await page.getByTestId("cache-intercept-link-a").click();
    await waitForHydration(page);
    await expect(page.getByTestId("cache-test-modal")).toBeVisible();

    // Wait for cache write
    await page.waitForTimeout(500);

    // Close modal by navigating back
    await page.goBack();
    await waitForHydration(page);

    // Verify we're back at index
    await expect(page.getByTestId("cache-intercept-index")).toBeVisible();

    // Record stdout before second intercept
    const beforeSecondStdout = f.proc().stdout();
    const beforeSecondLen = beforeSecondStdout.length;

    // Second intercept navigation to same item
    await page.getByTestId("cache-intercept-link-a").click();
    await waitForHydration(page);
    await expect(page.getByTestId("cache-test-modal")).toBeVisible();

    // Check logs - should be a HIT for intercept:
    const afterSecondStdout = f.proc().stdout();
    const secondLogs = getCacheLogs(afterSecondStdout.substring(beforeSecondLen));

    expect(
      secondLogs.hits.some((log) => log.includes("intercept:"))
    ).toBeTruthy();
  });

  test("loader data is rendered in cached intercept segment", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // First navigation - populate cache
    await page.goto(f.url("/cache-test/intercept"));
    await waitForHydration(page);

    await page.getByTestId("cache-intercept-link-a").click();
    await waitForHydration(page);
    await expect(page.getByTestId("cache-test-modal")).toBeVisible();

    // Get the initial count - loader data is passed via ctx.use() -> props
    const firstCount = await page.getByTestId("cache-test-modal-count").textContent();
    expect(firstCount).toContain("Count:");

    // Wait for cache write
    await page.waitForTimeout(500);

    // Go back and do another intercept navigation
    await page.goBack();
    await waitForHydration(page);

    await page.getByTestId("cache-intercept-link-a").click();
    await waitForHydration(page);
    await expect(page.getByTestId("cache-test-modal")).toBeVisible();

    // Get the second count - since segment is cached and loader data is passed
    // via props, the data is part of the cached segment
    const secondCount = await page.getByTestId("cache-test-modal-count").textContent();
    expect(secondCount).toContain("Count:");

    // Note: With ctx.use() + props pattern, the data is part of the RSC output
    // and gets cached with the segment. For fresh data despite cached segment,
    // use useFetchLoader in a client component instead.
  });
});

test.describe("useLoader-with-loader-registration", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
    isolatedServer: true,
  });

  test("useLoader works on direct navigation to detail page (regular route)", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // Direct navigation to detail page - useLoader works on regular routes
    await page.goto(f.url("/cache-test/useloader/item-a"));
    await waitForHydration(page);

    // Should show full detail page
    await expect(page.getByTestId("useloader-intercept-detail")).toBeVisible();

    // useLoader should have data from loader() registration on regular route
    await expect(page.getByTestId("detail-useloader-data")).toBeVisible();
    const count = await page.getByTestId("detail-useloader-data-count").textContent();
    expect(count).toContain("Count:");
  });

  test("useLoader gets fresh data on each direct navigation (non-cached route)", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // First direct navigation
    await page.goto(f.url("/cache-test/useloader/item-a"));
    await waitForHydration(page);
    await expect(page.getByTestId("detail-useloader-data")).toBeVisible();

    // Get first count
    const firstCount = await page.getByTestId("detail-useloader-data-count").textContent();

    // Navigate away
    await page.goto(f.url("/"));
    await waitForHydration(page);

    // Second direct navigation
    await page.goto(f.url("/cache-test/useloader/item-a"));
    await waitForHydration(page);
    await expect(page.getByTestId("detail-useloader-data")).toBeVisible();

    // Get second count - should be different (loader runs fresh, not cached)
    const secondCount = await page.getByTestId("detail-useloader-data-count").textContent();

    // Counts should be different because this route is not cached
    expect(secondCount).not.toBe(firstCount);
  });

  test("useLoader in client component works on intercept with loader() registration", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // Start at the useLoader intercept index page
    await page.goto(f.url("/cache-test/useloader"));
    await waitForHydration(page);

    // Verify we're on the index
    await expect(page.getByTestId("useloader-intercept-index")).toBeVisible();

    // Click link - this triggers intercept
    await page.getByTestId("useloader-link-a").click();
    await waitForHydration(page);

    // Modal should appear with data from useLoader
    await expect(page.getByTestId("useloader-modal")).toBeVisible();
    await expect(page.getByTestId("useloader-modal-indicator")).toHaveText("useLoader Modal");

    // Verify loader data is available via useLoader
    const count = await page.getByTestId("useloader-modal-count").textContent();
    expect(count).toContain("Count:");

    const message = await page.getByTestId("useloader-modal-message").textContent();
    expect(message).toBe("Intercept cache test data");
  });
});

test.describe("proactive-caching", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
    isolatedServer: true,
  });

  test("proactive caching triggers when navigating within cached layout", async ({
    page,
  }) => {
    // Step 1: Document request to item-a (MISS - first visit)
    const beforeFirstVisit = f.proc().stdout();
    await page.goto(f.url("/proactive-cache/item-a"));
    await waitForHydration(page);
    const afterFirstVisit = f.proc().stdout();
    const firstVisitLogs = afterFirstVisit.slice(beforeFirstVisit.length);

    // Verify layout and content rendered
    await expect(page.getByTestId("proactive-cache-layout")).toBeVisible();
    await expect(page.getByTestId("proactive-item-a-page")).toBeVisible();

    // Should have cache MISS on first visit
    expect(firstVisitLogs).toContain("[CacheScope] MISS:");

    // Step 2: Partial navigation to item-b (within same layout)
    // This triggers proactive caching because layout has null component
    const beforePartialNav = f.proc().stdout();
    await page.getByTestId("proactive-nav-b").click();
    await expect(page.getByTestId("proactive-item-b-page")).toBeVisible();

    // Give proactive caching time to complete in background
    await page.waitForTimeout(500);

    const afterPartialNav = f.proc().stdout();
    const partialNavLogs = afterPartialNav.slice(beforePartialNav.length);

    // Check for proactive caching log - this proves the feature triggered
    expect(partialNavLogs).toContain("proactive caching started");
  });

  test("layout renders correctly after proactive caching", async ({ page }) => {
    // Step 1: Document request to index (populates cache)
    await page.goto(f.url("/proactive-cache"));
    await waitForHydration(page);
    await expect(page.getByTestId("proactive-cache-layout")).toBeVisible();
    await expect(page.getByTestId("proactive-index-page")).toBeVisible();

    // Step 2: Partial nav to item-a (triggers proactive caching for layout)
    await page.getByTestId("proactive-nav-a").click();
    await expect(page.getByTestId("proactive-item-a-page")).toBeVisible();

    // Wait for proactive caching to complete
    await page.waitForTimeout(500);

    // Step 3: Navigate to home (outside cached layout)
    await page.getByTestId("proactive-back-home").click();
    await waitForHydration(page);

    // Step 4: Hard navigate to item-a
    // Should use cached layout from proactive caching (not broken null components)
    await page.goto(f.url("/proactive-cache/item-a"));
    await waitForHydration(page);

    // Layout should be visible and functional
    await expect(page.getByTestId("proactive-cache-layout")).toBeVisible();
    await expect(page.getByTestId("proactive-layout-title")).toHaveText(
      "Proactive Cache Layout"
    );
    await expect(page.getByTestId("proactive-item-a-page")).toBeVisible();

    // Navigation within layout should work
    await page.getByTestId("proactive-nav-b").click();
    await expect(page.getByTestId("proactive-item-b-page")).toBeVisible();
  });
});
