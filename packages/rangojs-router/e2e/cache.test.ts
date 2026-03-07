import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError } from "./helper";

/**
 * Poll server stdout for a [CacheScope] Cached: log entry matching the given path.
 * Replaces fixed waitForTimeout(500) calls for async cache write completion.
 */
async function waitForCacheWrite(
  proc: { stdout: () => string },
  sinceOffset: number,
  pathPattern: string,
  timeout = 5000,
) {
  await expect
    .poll(
      () => {
        const newOutput = proc.stdout().slice(sinceOffset);
        return newOutput
          .split("\n")
          .some(
            (line) =>
              line.includes("[CacheScope] Cached:") &&
              line.includes(pathPattern),
          );
      },
      {
        timeout,
        message: `Expected single [CacheScope] Cached: log line containing "${pathPattern}"`,
      },
    )
    .toBe(true);
}

/**
 * Tests that validate caching behavior by checking server logs.
 * The test-app has blog routes wrapped in cache({ ttl: 600 }) for testing.
 *
 * Cache log format (key includes host since cache keys are host-scoped):
 * - [CacheScope] MISS: doc:localhost:PORT/blog - Cache miss for document request
 * - [CacheScope] Cached: doc:localhost:PORT/blog (...) ttl=600s - Cache write confirmation
 * - [CacheScope] HIT: doc:localhost:PORT/blog (...) - Cache hit for subsequent request
 * - [CacheScope] STALE: doc:localhost:PORT/blog (...) - Stale response (SWR revalidation triggered)
 */

test.describe("cache-server-logs", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
    isolatedServer: true,
    cliOptions: { env: { INTERNAL_RANGO_DEBUG: "1" } },
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

    // Wait for async cache write to complete
    await waitForCacheWrite(f.proc(), initialLength, "/blog");

    // Get new logs since first request
    const afterFirstStdout = f.proc().stdout();
    const firstLogs = getCacheLogs(afterFirstStdout.substring(initialLength));

    // Should have exactly one MISS for doc:/blog
    expect(firstLogs.misses.some((log) => log.includes("/blog"))).toBe(true);

    // Should have a Cached log after async write
    expect(firstLogs.cached.some((log) => log.includes("/blog"))).toBe(true);

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
    const secondLogs = getCacheLogs(
      afterSecondStdout.substring(beforeSecondLength),
    );

    // Should have a HIT for doc:/blog (not MISS)
    expect(secondLogs.hits.some((log) => log.includes("/blog"))).toBe(true);
    expect(secondLogs.misses.some((log) => log.includes("/blog"))).toBeFalsy();
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

    // Wait for async cache write to complete
    await waitForCacheWrite(f.proc(), beforeNavLength, "/blog");

    // Check logs - should see partial:/blog MISS
    const afterNavStdout = f.proc().stdout();
    const navLogs = getCacheLogs(afterNavStdout.substring(beforeNavLength));

    // Should have MISS for partial:/blog
    expect(navLogs.misses.some((log) => log.includes("/blog"))).toBe(true);

    // Should have Cached for partial:/blog
    expect(navLogs.cached.some((log) => log.includes("/blog"))).toBe(true);

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
    const secondNavLogs = getCacheLogs(
      afterSecondNav.substring(beforeSecondNavLen),
    );

    expect(secondNavLogs.hits.some((log) => log.includes("/blog"))).toBe(true);
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

    await expect(page.getByTestId("blog-post-title")).toHaveText(
      "Post: post-1",
    );

    // Wait for async cache write to complete
    await waitForCacheWrite(f.proc(), initialLength, "/blog/post-1");

    const afterFirstStdout = f.proc().stdout();
    const firstLogs = getCacheLogs(afterFirstStdout.substring(initialLength));

    // Should have MISS for doc:/blog/post-1 with params
    expect(
      firstLogs.misses.some(
        (log) => log.includes("/blog/post-1") || log.includes("postId=post-1"),
      ),
    ).toBe(true);

    // Different post should have its own cache entry
    const beforeSecondPost = f.proc().stdout();
    const beforeSecondLen = beforeSecondPost.length;

    await page.goto(f.url("/blog/post-2"));
    await waitForHydration(page);

    await expect(page.getByTestId("blog-post-title")).toHaveText(
      "Post: post-2",
    );

    const afterSecondPost = f.proc().stdout();
    const secondLogs = getCacheLogs(afterSecondPost.substring(beforeSecondLen));

    // Should be a MISS (different cache key due to different param)
    expect(
      secondLogs.misses.some(
        (log) => log.includes("/blog/post-2") || log.includes("postId=post-2"),
      ),
    ).toBe(true);

    // Going back to post-1 should be a HIT
    const beforeThirdPost = f.proc().stdout();
    const beforeThirdLen = beforeThirdPost.length;

    await page.goto(f.url("/blog/post-1"));
    await waitForHydration(page);

    const afterThirdPost = f.proc().stdout();
    const thirdLogs = getCacheLogs(afterThirdPost.substring(beforeThirdLen));

    expect(
      thirdLogs.hits.some(
        (log) => log.includes("/blog/post-1") || log.includes("postId=post-1"),
      ),
    ).toBe(true);
  });

  test("__no_cache query param should bypass cache", async ({ page }) => {
    using _ = expectNoPageError(page);

    // Populate the cache (likely already cached by previous tests in this block)
    await page.goto(f.url("/blog"));
    await waitForHydration(page);

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

// ============================================================================
// Loader-level caching (dev)
// ============================================================================

test.describe("cache-loader-behavior", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
    isolatedServer: true,
    cliOptions: { env: { INTERNAL_RANGO_DEBUG: "1" } },
  });

  test("non-cached loader runs on every request", async ({ page }) => {
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
  });

  test("loader with cache() returns cached data on second request", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // First visit — cache miss, loader runs
    await page.goto(f.url("/cache-test/cached-loader"));
    await waitForHydration(page);

    const firstCount = await page.getByTestId("loader-count").textContent();
    const firstLoadedAt = await page.getByTestId("loaded-at").textContent();

    // Navigate away (round-trip provides time for async loader cache write)
    await page.goto(f.url("/"));
    await waitForHydration(page);

    // Second visit — cache hit, same data
    await page.goto(f.url("/cache-test/cached-loader"));
    await waitForHydration(page);

    const secondCount = await page.getByTestId("loader-count").textContent();
    const secondLoadedAt = await page.getByTestId("loaded-at").textContent();

    // Count should be the same (loader did NOT run again)
    expect(secondCount).toBe(firstCount);

    // loadedAt should be identical (cached data)
    expect(secondLoadedAt).toBe(firstLoadedAt);
  });
});

// ============================================================================
// Loader-level caching (production)
// ============================================================================

test.describe("cache-loader-behavior (production)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "build",
    isolatedServer: true,
    cliOptions: { env: { INTERNAL_RANGO_DEBUG: "1" } },
  });

  test("non-cached loader runs on every request", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/cache-test/non-cached-loader"));
    await waitForHydration(page);

    const firstCount = await page.getByTestId("loader-count").textContent();
    expect(firstCount).toContain("1");

    await page.goto(f.url("/"));
    await waitForHydration(page);

    await page.goto(f.url("/cache-test/non-cached-loader"));
    await waitForHydration(page);

    const secondCount = await page.getByTestId("loader-count").textContent();
    expect(secondCount).toContain("2");
  });

  test("loader with cache() returns cached data on second request", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/cache-test/cached-loader"));
    await waitForHydration(page);

    const firstCount = await page.getByTestId("loader-count").textContent();
    const firstLoadedAt = await page.getByTestId("loaded-at").textContent();

    // Round-trip provides time for async loader cache write
    await page.goto(f.url("/"));
    await waitForHydration(page);

    await page.goto(f.url("/cache-test/cached-loader"));
    await waitForHydration(page);

    const secondCount = await page.getByTestId("loader-count").textContent();
    const secondLoadedAt = await page.getByTestId("loaded-at").textContent();

    expect(secondCount).toBe(firstCount);
    expect(secondLoadedAt).toBe(firstLoadedAt);
  });
});

test.describe("cache-intercept-routes", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
    isolatedServer: true,
    cliOptions: { env: { INTERNAL_RANGO_DEBUG: "1" } },
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
    await expect(page.getByTestId("cache-test-modal-indicator")).toHaveText(
      "Cache Test Intercept",
    );

    // Wait for async cache write to complete
    await waitForCacheWrite(f.proc(), beforeInterceptLen, "intercept:");

    // Check logs - should see intercept: prefix in cache key
    const afterInterceptStdout = f.proc().stdout();
    const interceptLogs = getCacheLogs(
      afterInterceptStdout.substring(beforeInterceptLen),
    );

    // Should have MISS for intercept:
    expect(interceptLogs.misses.some((log) => log.includes("intercept:"))).toBe(
      true,
    );

    // Should have Cached for intercept:
    expect(interceptLogs.cached.some((log) => log.includes("intercept:"))).toBe(
      true,
    );
  });

  test("intercept cache should be separate from document cache", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // First, do a document request to the detail page (direct navigation)
    const beforeDocVisit = f.proc().stdout().length;
    await page.goto(f.url("/cache-test/intercept/item-b"));
    await waitForHydration(page);

    // Verify it's the full detail page (not modal)
    await expect(page.getByTestId("cache-intercept-detail")).toBeVisible();

    // Wait for async cache write (doc:/cache-test/intercept/item-b)
    await waitForCacheWrite(
      f.proc(),
      beforeDocVisit,
      "/cache-test/intercept/item-b",
    );

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

    // Wait for async cache write to complete
    await waitForCacheWrite(f.proc(), beforeInterceptLen, "intercept:");

    // Check logs - should be a MISS for intercept: (separate cache from doc:)
    const afterInterceptStdout = f.proc().stdout();
    const interceptLogs = getCacheLogs(
      afterInterceptStdout.substring(beforeInterceptLen),
    );

    // Should be a MISS because intercept cache is separate from doc cache
    expect(interceptLogs.misses.some((log) => log.includes("intercept:"))).toBe(
      true,
    );
  });

  test("intercept cache hit on second navigation", async ({ page }) => {
    using _ = expectNoPageError(page);

    // Start at intercept index
    await page.goto(f.url("/cache-test/intercept"));
    await waitForHydration(page);

    // First intercept navigation (cache already populated by previous test)
    await page.getByTestId("cache-intercept-link-a").click();
    await waitForHydration(page);
    await expect(page.getByTestId("cache-test-modal")).toBeVisible();

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
    const secondLogs = getCacheLogs(
      afterSecondStdout.substring(beforeSecondLen),
    );

    expect(secondLogs.hits.some((log) => log.includes("intercept:"))).toBe(
      true,
    );
  });

  test("loader data is rendered in cached intercept segment", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // First navigation - cache already populated by previous tests
    await page.goto(f.url("/cache-test/intercept"));
    await waitForHydration(page);

    await page.getByTestId("cache-intercept-link-a").click();
    await waitForHydration(page);
    await expect(page.getByTestId("cache-test-modal")).toBeVisible();

    // Get the initial count - loader data is passed via ctx.use() -> props
    const firstCount = await page
      .getByTestId("cache-test-modal-count")
      .textContent();
    expect(firstCount).toContain("Count:");

    // Go back and do another intercept navigation
    await page.goBack();
    await waitForHydration(page);

    await page.getByTestId("cache-intercept-link-a").click();
    await waitForHydration(page);
    await expect(page.getByTestId("cache-test-modal")).toBeVisible();

    // Get the second count - since segment is cached and loader data is passed
    // via props, the data is part of the cached segment
    const secondCount = await page
      .getByTestId("cache-test-modal-count")
      .textContent();
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
    const count = await page
      .getByTestId("detail-useloader-data-count")
      .textContent();
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
    const firstCount = await page
      .getByTestId("detail-useloader-data-count")
      .textContent();

    // Navigate away
    await page.goto(f.url("/"));
    await waitForHydration(page);

    // Second direct navigation
    await page.goto(f.url("/cache-test/useloader/item-a"));
    await waitForHydration(page);
    await expect(page.getByTestId("detail-useloader-data")).toBeVisible();

    // Get second count - should be different (loader runs fresh, not cached)
    const secondCount = await page
      .getByTestId("detail-useloader-data-count")
      .textContent();

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
    await expect(page.getByTestId("useloader-modal-indicator")).toHaveText(
      "useLoader Modal",
    );

    // Verify loader data is available via useLoader
    const count = await page.getByTestId("useloader-modal-count").textContent();
    expect(count).toContain("Count:");

    const message = await page
      .getByTestId("useloader-modal-message")
      .textContent();
    expect(message).toBe("Intercept cache test data");
  });
});

test.describe("proactive-caching", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
    isolatedServer: true,
    cliOptions: { env: { INTERNAL_RANGO_DEBUG: "1" } },
  });

  test("proactive caching populates cache for future partial navigations", async ({
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
    await page.getByTestId("proactive-nav-b").click();
    await expect(page.getByTestId("proactive-item-b-page")).toBeVisible();

    // Wait for proactive caching to complete in background
    // Proactive caching stores under the partial: key prefix, so verify
    // with a [CacheScope] Cached: log for item-b
    await expect
      .poll(
        () => {
          const stdout = f.proc().stdout().slice(afterFirstVisit.length);
          return (
            stdout.includes("[CacheScope] Cached:") &&
            stdout.includes("/proactive-cache/item-b")
          );
        },
        {
          timeout: 5000,
          message: "Expected proactive cache write for /proactive-cache/item-b",
        },
      )
      .toBe(true);
  });

  test("layout renders correctly after proactive caching", async ({ page }) => {
    // Step 1: Document request to index (populates cache)
    await page.goto(f.url("/proactive-cache"));
    await waitForHydration(page);
    await expect(page.getByTestId("proactive-cache-layout")).toBeVisible();
    await expect(page.getByTestId("proactive-index-page")).toBeVisible();

    // Step 2: Partial nav to item-a (triggers proactive caching for layout)
    const beforeNavA = f.proc().stdout().length;
    await page.getByTestId("proactive-nav-a").click();
    await expect(page.getByTestId("proactive-item-a-page")).toBeVisible();

    // Wait for proactive cache write to complete
    await waitForCacheWrite(f.proc(), beforeNavA, "/proactive-cache/item-a");

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
      "Proactive Cache Layout",
    );
    await expect(page.getByTestId("proactive-item-a-page")).toBeVisible();

    // Navigation within layout should work
    await page.getByTestId("proactive-nav-b").click();
    await expect(page.getByTestId("proactive-item-b-page")).toBeVisible();
  });
});

// ============================================================================
// Response type cache key differentiation (dev)
// ============================================================================

test.describe("cache-response-type", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
    isolatedServer: true,
  });

  test("path.json and path.text at same URL produce different cache entries", async ({
    request,
  }) => {
    // JSON response — cache miss
    const jsonRes1 = await request.get(f.url("/cache-response-type/data/42"), {
      headers: { Accept: "application/json" },
    });
    expect(jsonRes1.status()).toBe(200);
    const json1 = await jsonRes1.json();
    expect(json1.data.type).toBe("json");
    expect(json1.data.id).toBe("42");

    // Poll until cache write completes and second request returns cached data
    await expect
      .poll(
        async () => {
          const res = await request.get(f.url("/cache-response-type/data/42"), {
            headers: { Accept: "application/json" },
          });
          const data = await res.json();
          return data.data.ts;
        },
        { timeout: 5000, message: "Expected cached JSON response for /42" },
      )
      .toBe(json1.data.ts);

    // Verify full cache hit (rand should also match)
    const jsonRes2 = await request.get(f.url("/cache-response-type/data/42"), {
      headers: { Accept: "application/json" },
    });
    expect(jsonRes2.status()).toBe(200);
    const json2 = await jsonRes2.json();
    expect(json2.data.rand).toBe(json1.data.rand);

    // Text response at same URL — cache miss (different responseType key)
    const textRes1 = await request.get(f.url("/cache-response-type/data/42"), {
      headers: { Accept: "text/plain" },
    });
    expect(textRes1.status()).toBe(200);
    const text1 = await textRes1.text();
    expect(text1).toContain("text:42:");

    // Text value should differ from JSON timestamp (different cache entry)
    const textTs = text1.split(":")[2];
    expect(textTs).not.toBe(String(json1.data.ts));
  });

  test("path.json with different params produce different cache entries", async ({
    request,
  }) => {
    const res1 = await request.get(f.url("/cache-response-type/data/alpha"), {
      headers: { Accept: "application/json" },
    });
    expect(res1.status()).toBe(200);
    const body1 = await res1.json();
    expect(body1.data.id).toBe("alpha");

    // Poll until cache write completes for alpha
    await expect
      .poll(
        async () => {
          const res = await request.get(
            f.url("/cache-response-type/data/alpha"),
            { headers: { Accept: "application/json" } },
          );
          const data = await res.json();
          return data.data.ts;
        },
        { timeout: 5000, message: "Expected cached JSON response for /alpha" },
      )
      .toBe(body1.data.ts);

    // Different param — cache miss
    const res2 = await request.get(f.url("/cache-response-type/data/beta"), {
      headers: { Accept: "application/json" },
    });
    expect(res2.status()).toBe(200);
    const body2 = await res2.json();
    expect(body2.data.id).toBe("beta");
    expect(body2.data.ts).not.toBe(body1.data.ts);

    // Same param — cache hit
    const res3 = await request.get(f.url("/cache-response-type/data/alpha"), {
      headers: { Accept: "application/json" },
    });
    expect(res3.status()).toBe(200);
    const body3 = await res3.json();
    expect(body3.data.ts).toBe(body1.data.ts);
  });
});

// ============================================================================
// Response type cache key differentiation (production)
// ============================================================================

// ============================================================================
// Non-200 status responses are NOT cached (dev)
// ============================================================================

test.describe("cache-status-json", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
    isolatedServer: true,
  });

  test("404 response is NOT cached", async ({ request }) => {
    // First request — handler executes
    const res1 = await request.get(f.url("/cache-status-json/not-found"));
    expect(res1.status()).toBe(404);
    const body1 = await res1.json();
    expect(body1.error).toBe("not found");

    // Second request — handler re-executes (NOT cached, only 200 is cached)
    const res2 = await request.get(f.url("/cache-status-json/not-found"));
    expect(res2.status()).toBe(404);
    const body2 = await res2.json();
    expect(body2.ts).not.toBe(body1.ts);
  });

  test("500 response is NOT cached", async ({ request }) => {
    // First request — handler executes
    const res1 = await request.get(f.url("/cache-status-json/server-error"));
    expect(res1.status()).toBe(500);
    const body1 = await res1.json();
    expect(body1.error).toBe("server error");

    // Second request — handler re-executes (NOT cached)
    const res2 = await request.get(f.url("/cache-status-json/server-error"));
    expect(res2.status()).toBe(500);
    const body2 = await res2.json();
    // Timestamps should differ since 500 is not cached
    expect(body2.ts).not.toBe(body1.ts);
  });
});

// ============================================================================
// Non-200 status responses are NOT cached (production)
// ============================================================================

test.describe("cache-status-json (production)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "build",
  });

  test("404 response is NOT cached", async ({ request }) => {
    const res1 = await request.get(f.url("/cache-status-json/not-found"));
    expect(res1.status()).toBe(404);
    const body1 = await res1.json();
    expect(body1.error).toBe("not found");

    const res2 = await request.get(f.url("/cache-status-json/not-found"));
    expect(res2.status()).toBe(404);
    const body2 = await res2.json();
    expect(body2.ts).not.toBe(body1.ts);
  });

  test("500 response is NOT cached", async ({ request }) => {
    const res1 = await request.get(f.url("/cache-status-json/server-error"));
    expect(res1.status()).toBe(500);
    const body1 = await res1.json();
    expect(body1.error).toBe("server error");

    const res2 = await request.get(f.url("/cache-status-json/server-error"));
    expect(res2.status()).toBe(500);
    const body2 = await res2.json();
    expect(body2.ts).not.toBe(body1.ts);
  });
});

// ============================================================================
// Segment-level cache status behavior (dev)
// ============================================================================

test.describe("cache-status-segment", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
    isolatedServer: true,
    cliOptions: { env: { INTERNAL_RANGO_DEBUG: "1" } },
  });

  test("200 segment route is cached on second visit", async ({ page }) => {
    using _ = expectNoPageError(page);

    const beforeSuccessVisit = f.proc().stdout().length;
    await page.goto(f.url("/cache-status/success"));
    await waitForHydration(page);

    await expect(page.getByTestId("cache-status-success-title")).toHaveText(
      "Cache Status: Success (200)",
    );
    const firstRendered = await page
      .getByTestId("cache-status-success-rendered")
      .textContent();

    // Wait for async cache write to complete
    await waitForCacheWrite(
      f.proc(),
      beforeSuccessVisit,
      "/cache-status/success",
    );

    // Navigate away and back
    await page.goto(f.url("/"));
    await waitForHydration(page);
    await page.goto(f.url("/cache-status/success"));
    await waitForHydration(page);

    const secondRendered = await page
      .getByTestId("cache-status-success-rendered")
      .textContent();

    // Cached: same rendered timestamp
    expect(secondRendered).toBe(firstRendered);
  });

  test("notFound() boundary is cached after first render", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/cache-status/not-found"));
    await waitForHydration(page);

    // notFoundBoundary should catch and render 404 UI
    await expect(page.getByTestId("cache-status-not-found-title")).toHaveText(
      "Not Found (404)",
    );
    await expect(page.getByTestId("cache-status-not-found-message")).toHaveText(
      "This resource does not exist",
    );
  });

  test("redirect handler works correctly", async ({ page }) => {
    using _ = expectNoPageError(page);

    // Navigate to redirect route — should end up at redirect target
    await page.goto(f.url("/cache-status/redirect"));
    await waitForHydration(page);

    // Should have been redirected to the target
    await expect(
      page.getByTestId("cache-status-redirect-target-title"),
    ).toHaveText("Cache Status: Redirect Target (200)");
  });
});

// ============================================================================
// Segment-level cache status behavior (production)
// ============================================================================

test.describe("cache-status-segment (production)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "build",
    isolatedServer: true,
    cliOptions: { env: { INTERNAL_RANGO_DEBUG: "1" } },
  });

  test("200 segment route is cached on second visit", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/cache-status/success"));
    await waitForHydration(page);

    await expect(page.getByTestId("cache-status-success-title")).toHaveText(
      "Cache Status: Success (200)",
    );
    const firstRendered = await page
      .getByTestId("cache-status-success-rendered")
      .textContent();

    // Round-trip provides time for async cache write
    await page.goto(f.url("/"));
    await waitForHydration(page);
    await page.goto(f.url("/cache-status/success"));
    await waitForHydration(page);

    const secondRendered = await page
      .getByTestId("cache-status-success-rendered")
      .textContent();

    expect(secondRendered).toBe(firstRendered);
  });

  test("notFound() boundary is cached after first render", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/cache-status/not-found"));
    await waitForHydration(page);

    await expect(page.getByTestId("cache-status-not-found-title")).toHaveText(
      "Not Found (404)",
    );
    await expect(page.getByTestId("cache-status-not-found-message")).toHaveText(
      "This resource does not exist",
    );
  });

  test("redirect handler works correctly", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/cache-status/redirect"));
    await waitForHydration(page);

    await expect(
      page.getByTestId("cache-status-redirect-target-title"),
    ).toHaveText("Cache Status: Redirect Target (200)");
  });
});

test.describe("cache-response-type (production)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "build",
  });

  test("path.json and path.text at same URL produce different cache entries", async ({
    request,
  }) => {
    const jsonRes1 = await request.get(f.url("/cache-response-type/data/42"), {
      headers: { Accept: "application/json" },
    });
    expect(jsonRes1.status()).toBe(200);
    const json1 = await jsonRes1.json();
    expect(json1.data.type).toBe("json");
    expect(json1.data.id).toBe("42");

    // Poll until cache write completes and second request returns cached data
    await expect
      .poll(
        async () => {
          const res = await request.get(f.url("/cache-response-type/data/42"), {
            headers: { Accept: "application/json" },
          });
          const data = await res.json();
          return data.data.ts;
        },
        { timeout: 5000, message: "Expected cached JSON response for /42" },
      )
      .toBe(json1.data.ts);

    // Verify full cache hit (rand should also match)
    const jsonRes2 = await request.get(f.url("/cache-response-type/data/42"), {
      headers: { Accept: "application/json" },
    });
    expect(jsonRes2.status()).toBe(200);
    const json2 = await jsonRes2.json();
    expect(json2.data.rand).toBe(json1.data.rand);

    const textRes1 = await request.get(f.url("/cache-response-type/data/42"), {
      headers: { Accept: "text/plain" },
    });
    expect(textRes1.status()).toBe(200);
    const text1 = await textRes1.text();
    expect(text1).toContain("text:42:");

    const textTs = text1.split(":")[2];
    expect(textTs).not.toBe(String(json1.data.ts));
  });

  test("path.json with different params produce different cache entries", async ({
    request,
  }) => {
    const res1 = await request.get(f.url("/cache-response-type/data/alpha"), {
      headers: { Accept: "application/json" },
    });
    expect(res1.status()).toBe(200);
    const body1 = await res1.json();
    expect(body1.data.id).toBe("alpha");

    // Poll until cache write completes for alpha
    await expect
      .poll(
        async () => {
          const res = await request.get(
            f.url("/cache-response-type/data/alpha"),
            { headers: { Accept: "application/json" } },
          );
          const data = await res.json();
          return data.data.ts;
        },
        { timeout: 5000, message: "Expected cached JSON response for /alpha" },
      )
      .toBe(body1.data.ts);

    const res2 = await request.get(f.url("/cache-response-type/data/beta"), {
      headers: { Accept: "application/json" },
    });
    expect(res2.status()).toBe(200);
    const body2 = await res2.json();
    expect(body2.data.id).toBe("beta");
    expect(body2.data.ts).not.toBe(body1.data.ts);

    const res3 = await request.get(f.url("/cache-response-type/data/alpha"), {
      headers: { Accept: "application/json" },
    });
    expect(res3.status()).toBe(200);
    const body3 = await res3.json();
    expect(body3.data.ts).toBe(body1.data.ts);
  });
});

// ============================================================================
// ReactNode loader return type (dev)
// ============================================================================

test.describe("cache-loader-reactnode", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
    isolatedServer: true,
    cliOptions: { env: { INTERNAL_RANGO_DEBUG: "1" } },
  });

  test("cached ReactNode loader returns serialized JSX on cache hit", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // First visit — cache miss, loader runs
    await page.goto(f.url("/cache-test/react-node-cached"));
    await waitForHydration(page);

    await expect(page.getByTestId("react-node-cached-page")).toBeVisible();
    const firstCount = await page.getByTestId("rn-count").textContent();
    const firstTs = await page.getByTestId("rn-ts").textContent();
    expect(firstCount).toMatch(/^\d+$/);
    expect(firstTs).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // Navigate away (round-trip provides time for async loader cache write)
    await page.goto(f.url("/"));
    await waitForHydration(page);

    // Second visit — cache hit, same ReactNode
    await page.goto(f.url("/cache-test/react-node-cached"));
    await waitForHydration(page);

    const secondCount = await page.getByTestId("rn-count").textContent();
    const secondTs = await page.getByTestId("rn-ts").textContent();

    // Cached: same count and timestamp
    expect(secondCount).toBe(firstCount);
    expect(secondTs).toBe(firstTs);
  });

  test("non-cached ReactNode loader runs fresh on every request", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/cache-test/react-node-non-cached"));
    await waitForHydration(page);

    await expect(page.getByTestId("react-node-non-cached-page")).toBeVisible();
    const firstCount = await page.getByTestId("rn-count").textContent();

    await page.goto(f.url("/"));
    await waitForHydration(page);

    await page.goto(f.url("/cache-test/react-node-non-cached"));
    await waitForHydration(page);

    const secondCount = await page.getByTestId("rn-count").textContent();

    // Not cached: count should increment
    expect(Number(secondCount)).toBeGreaterThan(Number(firstCount));
  });
});

// ============================================================================
// ReactNode loader return type (production)
// ============================================================================

test.describe("cache-loader-reactnode (production)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "build",
    isolatedServer: true,
    cliOptions: { env: { INTERNAL_RANGO_DEBUG: "1" } },
  });

  test("cached ReactNode loader returns serialized JSX on cache hit", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/cache-test/react-node-cached"));
    await waitForHydration(page);

    await expect(page.getByTestId("react-node-cached-page")).toBeVisible();
    const firstCount = await page.getByTestId("rn-count").textContent();
    const firstTs = await page.getByTestId("rn-ts").textContent();
    expect(firstCount).toMatch(/^\d+$/);
    expect(firstTs).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    await page.goto(f.url("/"));
    await waitForHydration(page);

    await page.goto(f.url("/cache-test/react-node-cached"));
    await waitForHydration(page);

    const secondCount = await page.getByTestId("rn-count").textContent();
    const secondTs = await page.getByTestId("rn-ts").textContent();

    expect(secondCount).toBe(firstCount);
    expect(secondTs).toBe(firstTs);
  });

  test("non-cached ReactNode loader runs fresh on every request", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/cache-test/react-node-non-cached"));
    await waitForHydration(page);

    await expect(page.getByTestId("react-node-non-cached-page")).toBeVisible();
    const firstCount = await page.getByTestId("rn-count").textContent();

    await page.goto(f.url("/"));
    await waitForHydration(page);

    await page.goto(f.url("/cache-test/react-node-non-cached"));
    await waitForHydration(page);

    const secondCount = await page.getByTestId("rn-count").textContent();

    expect(Number(secondCount)).toBeGreaterThan(Number(firstCount));
  });
});

// ============================================================================
// Null loader return type (dev)
// ============================================================================

test.describe("cache-loader-null", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
    isolatedServer: true,
    cliOptions: { env: { INTERNAL_RANGO_DEBUG: "1" } },
  });

  test("cached null-value loader preserves null through cache round-trip", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // First visit — cache miss
    await page.goto(f.url("/cache-test/null-cached"));
    await waitForHydration(page);

    await expect(page.getByTestId("null-cached-page")).toBeVisible();
    await expect(page.getByTestId("null-value")).toHaveText("null");
    const firstCount = await page.getByTestId("null-count").textContent();

    // Navigate away (round-trip provides time for async loader cache write)
    await page.goto(f.url("/"));
    await waitForHydration(page);

    // Second visit — cache hit, null preserved
    await page.goto(f.url("/cache-test/null-cached"));
    await waitForHydration(page);

    await expect(page.getByTestId("null-value")).toHaveText("null");
    const secondCount = await page.getByTestId("null-count").textContent();

    // Cached: same count (loader did NOT run again)
    expect(secondCount).toBe(firstCount);
  });

  test("non-cached null-value loader runs fresh on every request", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/cache-test/null-non-cached"));
    await waitForHydration(page);

    await expect(page.getByTestId("null-non-cached-page")).toBeVisible();
    await expect(page.getByTestId("null-value")).toHaveText("null");
    const firstCount = await page.getByTestId("null-count").textContent();

    await page.goto(f.url("/"));
    await waitForHydration(page);

    await page.goto(f.url("/cache-test/null-non-cached"));
    await waitForHydration(page);

    await expect(page.getByTestId("null-value")).toHaveText("null");
    const secondCount = await page.getByTestId("null-count").textContent();

    // Not cached: count should increment
    expect(Number(secondCount)).toBeGreaterThan(Number(firstCount));
  });
});

// ============================================================================
// Null loader return type (production)
// ============================================================================

test.describe("cache-loader-null (production)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "build",
    isolatedServer: true,
    cliOptions: { env: { INTERNAL_RANGO_DEBUG: "1" } },
  });

  test("cached null-value loader preserves null through cache round-trip", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/cache-test/null-cached"));
    await waitForHydration(page);

    await expect(page.getByTestId("null-cached-page")).toBeVisible();
    await expect(page.getByTestId("null-value")).toHaveText("null");
    const firstCount = await page.getByTestId("null-count").textContent();

    await page.goto(f.url("/"));
    await waitForHydration(page);

    await page.goto(f.url("/cache-test/null-cached"));
    await waitForHydration(page);

    await expect(page.getByTestId("null-value")).toHaveText("null");
    const secondCount = await page.getByTestId("null-count").textContent();

    expect(secondCount).toBe(firstCount);
  });

  test("non-cached null-value loader runs fresh on every request", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/cache-test/null-non-cached"));
    await waitForHydration(page);

    await expect(page.getByTestId("null-non-cached-page")).toBeVisible();
    await expect(page.getByTestId("null-value")).toHaveText("null");
    const firstCount = await page.getByTestId("null-count").textContent();

    await page.goto(f.url("/"));
    await waitForHydration(page);

    await page.goto(f.url("/cache-test/null-non-cached"));
    await waitForHydration(page);

    await expect(page.getByTestId("null-value")).toHaveText("null");
    const secondCount = await page.getByTestId("null-count").textContent();

    expect(Number(secondCount)).toBeGreaterThan(Number(firstCount));
  });
});
