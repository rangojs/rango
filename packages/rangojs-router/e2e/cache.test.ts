import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError } from "./helper";

// This file intentionally exercises shared runtime cache behavior and several
// sections rely on cache state established earlier in the same describe/file.
// Keep it serial to avoid cross-test races against the shared fixture server.
test.describe.configure({ mode: "serial" });

/**
 * Poll server stdout for a [CacheScope] Cached: log entry matching the given path.
 * Replaces fixed waitForTimeout(500) calls for async cache write completion.
 */
async function waitForCacheWrite(
  proc: { stdout: () => string },
  sinceOffset: number,
  pathPattern: string,
  timeout = 15000,
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

async function waitForCacheHit(
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
              line.includes("[CacheScope] HIT:") && line.includes(pathPattern),
          );
      },
      {
        timeout,
        message: `Expected single [CacheScope] HIT: log line containing "${pathPattern}"`,
      },
    )
    .toBe(true);
}

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

    // Should have exactly one MISS for doc:{host}/blog
    expect(firstLogs.misses.some((log) => /doc:\S+\/blog/.test(log))).toBe(
      true,
    );

    // Should have a Cached log after async write
    expect(firstLogs.cached.some((log) => /doc:\S+\/blog/.test(log))).toBe(
      true,
    );

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

    await waitForCacheHit(f.proc(), beforeSecondLength, "/blog");

    // Get logs from second request
    const afterSecondStdout = f.proc().stdout();
    const secondLogs = getCacheLogs(
      afterSecondStdout.substring(beforeSecondLength),
    );

    // Should have a HIT for doc:{host}/blog (not MISS)
    expect(secondLogs.hits.some((log) => /doc:\S+\/blog/.test(log))).toBe(true);
    expect(
      secondLogs.misses.some((log) => /doc:\S+\/blog/.test(log)),
    ).toBeFalsy();
  });

  test("blog post with params should cache with params in key", async ({
    request,
  }) => {
    const initialStdout = f.proc().stdout();
    const initialLength = initialStdout.length;

    // Visit blog post with param
    const firstResponse = await request.get(f.url("/blog/post-1"));
    expect(firstResponse.status()).toBe(200);

    // Wait for async cache write to complete
    await waitForCacheWrite(f.proc(), initialLength, "/blog/post-1");

    const afterFirstStdout = f.proc().stdout();
    const firstLogs = getCacheLogs(afterFirstStdout.substring(initialLength));

    // Should have MISS for doc:{host}/blog/post-1 with params
    expect(
      firstLogs.misses.some(
        (log) =>
          /doc:\S+\/blog\/post-1/.test(log) || log.includes("postId=post-1"),
      ),
    ).toBe(true);

    // Different post should have its own cache entry
    const beforeSecondPost = f.proc().stdout();
    const beforeSecondLen = beforeSecondPost.length;

    const secondResponse = await request.get(f.url("/blog/post-2"));
    expect(secondResponse.status()).toBe(200);

    const afterSecondPost = f.proc().stdout();
    const secondLogs = getCacheLogs(afterSecondPost.substring(beforeSecondLen));

    // Should be a MISS (different cache key due to different param)
    expect(
      secondLogs.misses.some(
        (log) =>
          /doc:\S+\/blog\/post-2/.test(log) || log.includes("postId=post-2"),
      ),
    ).toBe(true);

    // The key contract here is param differentiation, not generic cache hits.
    // A separate test already covers repeated-hit behavior for document routes.
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

test.describe("cache-server-logs-partial", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
    isolatedServer: true,
    cliOptions: { env: { INTERNAL_RANGO_DEBUG: "1" } },
  });

  test("partial navigation should use different cache key", async ({
    request,
  }) => {
    const beforeNavStdout = f.proc().stdout();
    const beforeNavLength = beforeNavStdout.length;

    const response = await request.get(
      f.url("/blog?_rsc_partial=true&_rsc_segments=M0L0"),
    );
    expect(response.status()).toBe(200);

    await waitForCacheWrite(f.proc(), beforeNavLength, "/blog");

    const afterNavStdout = f.proc().stdout();
    const partialLogs = getCacheLogs(afterNavStdout.substring(beforeNavLength));

    expect(
      partialLogs.misses.some((log) => /partial:\S+\/blog/.test(log)),
    ).toBe(true);
    expect(
      partialLogs.cached.some((log) => /partial:\S+\/blog/.test(log)),
    ).toBe(true);
    expect(partialLogs.misses.some((log) => /doc:\S+\/blog/.test(log))).toBe(
      false,
    );
    expect(partialLogs.cached.some((log) => /doc:\S+\/blog/.test(log))).toBe(
      false,
    );
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
    const firstLoadedAt = await page.getByTestId("loaded-at").textContent();
    expect(firstCount).toContain("1");

    // Navigate away
    await page.goto(f.url("/"));
    await waitForHydration(page);

    // Second visit - loader should run again, count should increase
    await page.goto(f.url("/cache-test/non-cached-loader"));
    await waitForHydration(page);

    const secondCount = await page.getByTestId("loader-count").textContent();
    const secondLoadedAt = await page.getByTestId("loaded-at").textContent();

    expect(secondLoadedAt).not.toBe(firstLoadedAt);
    expect(secondCount).toBeTruthy();
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

    // Navigate away, then poll until the second visit serves the cached payload.
    await page.goto(f.url("/"));
    await waitForHydration(page);

    await expect
      .poll(
        async () => {
          await page.goto(f.url("/cache-test/cached-loader"));
          await waitForHydration(page);
          const count = await page.getByTestId("loader-count").textContent();
          const loadedAt = await page.getByTestId("loaded-at").textContent();
          return { count, loadedAt };
        },
        {
          timeout: 8000,
          message: "Expected cached loader payload on second visit",
        },
      )
      .toEqual({
        count: firstCount,
        loadedAt: firstLoadedAt,
      });
  });

  // Consumption-lane rule, cache() tier (docs/internal/execution-model.md;
  // the PPR twin is semantic matrix row PPR3): a route-level cache() scope
  // whose HANDLER consumes an UNCACHED loader via `await ctx.use(...)` serves
  // the BAKED copy on every hit — count and loadedAt frozen at the values the
  // cached render captured. Client-side useLoader is the live lane.
  test("route-level cache(): handler ctx.use value is a baked copy, frozen across hits", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/cache-test/handler-consumed"));
    await waitForHydration(page);

    const firstCount = await page.getByTestId("loader-count").textContent();
    const firstLoadedAt = await page.getByTestId("loaded-at").textContent();

    await page.goto(f.url("/"));
    await waitForHydration(page);

    await expect
      .poll(
        async () => {
          await page.goto(f.url("/cache-test/handler-consumed"));
          await waitForHydration(page);
          const count = await page.getByTestId("loader-count").textContent();
          const loadedAt = await page.getByTestId("loaded-at").textContent();
          return { count, loadedAt };
        },
        {
          timeout: 8000,
          message:
            "Expected the handler-consumed value to be served from cache",
        },
      )
      .toEqual({ count: firstCount, loadedAt: firstLoadedAt });
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
    const firstLoadedAt = await page.getByTestId("loaded-at").textContent();
    expect(firstCount).toContain("1");

    await page.goto(f.url("/"));
    await waitForHydration(page);

    await page.goto(f.url("/cache-test/non-cached-loader"));
    await waitForHydration(page);

    const secondCount = await page.getByTestId("loader-count").textContent();
    const secondLoadedAt = await page.getByTestId("loaded-at").textContent();

    expect(secondLoadedAt).not.toBe(firstLoadedAt);
    expect(secondCount).not.toBe(firstCount);
  });

  test("loader with cache() returns cached data on second request", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/cache-test/cached-loader"));
    await waitForHydration(page);

    const firstCount = await page.getByTestId("loader-count").textContent();
    const firstLoadedAt = await page.getByTestId("loaded-at").textContent();

    // Navigate away, then poll until the second visit serves the cached payload.
    await page.goto(f.url("/"));
    await waitForHydration(page);

    await expect
      .poll(
        async () => {
          await page.goto(f.url("/cache-test/cached-loader"));
          await waitForHydration(page);
          const count = await page.getByTestId("loader-count").textContent();
          const loadedAt = await page.getByTestId("loaded-at").textContent();
          return { count, loadedAt };
        },
        {
          timeout: 8000,
          message: "Expected cached loader payload on second visit",
        },
      )
      .toEqual({
        count: firstCount,
        loadedAt: firstLoadedAt,
      });
  });

  // Consumption-lane rule, cache() tier — production counterpart of the dev
  // case above (docs/internal/execution-model.md; PPR twin: semantic matrix
  // row PPR3).
  test("route-level cache(): handler ctx.use value is a baked copy, frozen across hits", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/cache-test/handler-consumed"));
    await waitForHydration(page);

    const firstCount = await page.getByTestId("loader-count").textContent();
    const firstLoadedAt = await page.getByTestId("loaded-at").textContent();

    await page.goto(f.url("/"));
    await waitForHydration(page);

    await expect
      .poll(
        async () => {
          await page.goto(f.url("/cache-test/handler-consumed"));
          await waitForHydration(page);
          const count = await page.getByTestId("loader-count").textContent();
          const loadedAt = await page.getByTestId("loaded-at").textContent();
          return { count, loadedAt };
        },
        {
          timeout: 8000,
          message:
            "Expected the handler-consumed value to be served from cache",
        },
      )
      .toEqual({ count: firstCount, loadedAt: firstLoadedAt });
  });
});

// Intentionally dev-only: these tests verify cache key differentiation
// (intercept: vs doc: prefix) and hit/miss behavior via debug log assertions
// that require INTERNAL_RANGO_DEBUG. The behavioral subset (modal renders,
// loader data visible) is covered in the production block below.
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
    await page.waitForTimeout(100);

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
});

// ============================================================================
// Intercept cache behavioral verification (production)
// ============================================================================

test.describe("cache-intercept-routes (production)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "build",
    isolatedServer: true,
  });

  test("intercept navigation renders modal with loader data", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/cache-test/intercept"));
    await waitForHydration(page);

    await expect(page.getByTestId("cache-intercept-index")).toBeVisible();

    // Click link — triggers intercept (modal opens)
    await page.getByTestId("cache-intercept-link-a").click();
    await waitForHydration(page);

    await expect(page.getByTestId("cache-test-modal")).toBeVisible();
    await expect(page.getByTestId("cache-test-modal-indicator")).toHaveText(
      "Cache Test Intercept",
    );

    // Loader data is rendered in the intercept segment
    const count = await page
      .getByTestId("cache-test-modal-count")
      .textContent();
    expect(count).toContain("Count:");
  });

  test("direct navigation shows full detail page (not modal)", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/cache-test/intercept/item-b"));
    await waitForHydration(page);

    await expect(page.getByTestId("cache-intercept-detail")).toBeVisible();
  });
});

// ============================================================================
// Cache hit with different route params (regression: param change must re-render)
// ============================================================================

test.describe("cache-hit-param-change", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });

  test("soft nav between different params on cached route should update content", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // Direct-navigate to item-a (document request, populates server cache)
    await page.goto(f.url("/cache-test/intercept/item-a"));
    await waitForHydration(page);
    await expect(page.getByTestId("cache-intercept-detail")).toBeVisible();
    await expect(page.getByTestId("detail-item-id")).toContainText("item-a");

    // Soft-nav to item-b via sibling link (bypasses intercept when() condition).
    // This is a partial request with clientSegmentSet populated from item-a.
    // Server cache for item-b may miss — segments resolve fresh.
    await page.getByTestId("detail-link-item-b").click();
    await expect(page.getByTestId("detail-item-id")).toContainText("item-b");

    // Soft-nav back to item-a (cache HIT — item-a was cached on first visit).
    // The cache-hit revalidation must detect the param change (item-b → item-a)
    // and re-render the route segment, not keep item-b's stale UI.
    await page.getByTestId("detail-link-item-a").click();
    await expect(page.getByTestId("detail-item-id")).toContainText("item-a");
  });

  test("soft nav between different search params on cached route should update content", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // Document request to search-params page (populates cache for ?page=1)
    await page.goto(f.url("/cache-test/search-params?page=1"));
    await waitForHydration(page);
    await expect(page.getByTestId("search-page-value")).toHaveText("page:1");

    // Soft-nav to ?page=2 via link
    await page.getByTestId("page-link-2").click();
    await expect(page.getByTestId("search-page-value")).toHaveText("page:2");

    // Soft-nav back to ?page=1 (cache hit, search params changed)
    await page.getByTestId("page-link-1").click();
    await expect(page.getByTestId("search-page-value")).toHaveText("page:1");
  });
});

test.describe("cache-hit-param-change (production)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "build",
  });

  test("soft nav between different params on cached route should update content", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/cache-test/intercept/item-a"));
    await waitForHydration(page);
    await expect(page.getByTestId("cache-intercept-detail")).toBeVisible();
    await expect(page.getByTestId("detail-item-id")).toContainText("item-a");

    await page.getByTestId("detail-link-item-b").click();
    await expect(page.getByTestId("detail-item-id")).toContainText("item-b");

    await page.getByTestId("detail-link-item-a").click();
    await expect(page.getByTestId("detail-item-id")).toContainText("item-a");
  });

  test("soft nav between different search params on cached route should update content", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/cache-test/search-params?page=1"));
    await waitForHydration(page);
    await expect(page.getByTestId("search-page-value")).toHaveText("page:1");

    await page.getByTestId("page-link-2").click();
    await expect(page.getByTestId("search-page-value")).toHaveText("page:2");

    await page.getByTestId("page-link-1").click();
    await expect(page.getByTestId("search-page-value")).toHaveText("page:1");
  });
});

// ============================================================================
// useLoader with loader() registration (dev)
// ============================================================================

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
    await page.waitForTimeout(100);

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

// ============================================================================
// useLoader with loader() registration (production)
// ============================================================================

test.describe("useLoader-with-loader-registration (production)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "build",
    isolatedServer: true,
  });

  test("useLoader works on direct navigation to detail page (regular route)", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/cache-test/useloader/item-a"));
    await waitForHydration(page);

    await expect(page.getByTestId("useloader-intercept-detail")).toBeVisible();

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

    await page.goto(f.url("/cache-test/useloader/item-a"));
    await waitForHydration(page);
    await expect(page.getByTestId("detail-useloader-data")).toBeVisible();

    const firstCount = await page
      .getByTestId("detail-useloader-data-count")
      .textContent();

    await page.goto(f.url("/"));
    await waitForHydration(page);

    await page.goto(f.url("/cache-test/useloader/item-a"));
    await waitForHydration(page);
    await expect(page.getByTestId("detail-useloader-data")).toBeVisible();

    const secondCount = await page
      .getByTestId("detail-useloader-data-count")
      .textContent();

    expect(secondCount).not.toBe(firstCount);
  });

  test("useLoader in client component works on intercept with loader() registration", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/cache-test/useloader"));
    await waitForHydration(page);

    await expect(page.getByTestId("useloader-intercept-index")).toBeVisible();

    await page.getByTestId("useloader-link-a").click();
    await waitForHydration(page);

    await expect(page.getByTestId("useloader-modal")).toBeVisible();
    await expect(page.getByTestId("useloader-modal-indicator")).toHaveText(
      "useLoader Modal",
    );

    const count = await page.getByTestId("useloader-modal-count").textContent();
    expect(count).toContain("Count:");

    const message = await page
      .getByTestId("useloader-modal-message")
      .textContent();
    expect(message).toBe("Intercept cache test data");
  });
});

// ============================================================================
// Proactive caching behavior (dev)
// ============================================================================

// Intentionally dev-only: these tests verify proactive cache population
// and hit/miss behavior via debug log assertions (INTERNAL_RANGO_DEBUG).
// The behavioral surface (layout renders correctly, navigation works after
// proactive caching) is covered by cloudflare-basic production tests in
// tests/cloudflare-basic/e2e/cache.test.ts.
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
          timeout: 15000,
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
    expect(json1.type).toBe("json");
    expect(json1.id).toBe("42");

    // Poll until cache write completes and second request returns cached data
    await expect
      .poll(
        async () => {
          const res = await request.get(f.url("/cache-response-type/data/42"), {
            headers: { Accept: "application/json" },
          });
          const data = await res.json();
          return data.ts;
        },
        { timeout: 15000, message: "Expected cached JSON response for /42" },
      )
      .toBe(json1.ts);

    // Verify full cache hit (rand should also match)
    const jsonRes2 = await request.get(f.url("/cache-response-type/data/42"), {
      headers: { Accept: "application/json" },
    });
    expect(jsonRes2.status()).toBe(200);
    const json2 = await jsonRes2.json();
    expect(json2.rand).toBe(json1.rand);

    // Text response at same URL — cache miss (different responseType key)
    const textRes1 = await request.get(f.url("/cache-response-type/data/42"), {
      headers: { Accept: "text/plain" },
    });
    expect(textRes1.status()).toBe(200);
    const text1 = await textRes1.text();
    expect(text1).toContain("text:42:");

    // Text value should differ from JSON timestamp (different cache entry)
    const textTs = text1.split(":")[2];
    expect(textTs).not.toBe(String(json1.ts));
  });

  test("path.json with different params produce different cache entries", async ({
    request,
  }) => {
    const res1 = await request.get(f.url("/cache-response-type/data/alpha"), {
      headers: { Accept: "application/json" },
    });
    expect(res1.status()).toBe(200);
    const body1 = await res1.json();
    expect(body1.id).toBe("alpha");

    // Poll until cache write completes for alpha
    await expect
      .poll(
        async () => {
          const res = await request.get(
            f.url("/cache-response-type/data/alpha"),
            { headers: { Accept: "application/json" } },
          );
          const data = await res.json();
          return data.ts;
        },
        { timeout: 15000, message: "Expected cached JSON response for /alpha" },
      )
      .toBe(body1.ts);

    // Different param — cache miss
    const res2 = await request.get(f.url("/cache-response-type/data/beta"), {
      headers: { Accept: "application/json" },
    });
    expect(res2.status()).toBe(200);
    const body2 = await res2.json();
    expect(body2.id).toBe("beta");
    expect(body2.ts).not.toBe(body1.ts);

    // Same param — cache hit
    const res3 = await request.get(f.url("/cache-response-type/data/alpha"), {
      headers: { Accept: "application/json" },
    });
    expect(res3.status()).toBe(200);
    const body3 = await res3.json();
    expect(body3.ts).toBe(body1.ts);
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

// __no_cache must bypass the cache in production too. Asserted on the payload
// (prod has no debug logs): proven only by the pair — a cached route is stable
// without the flag, and re-executes with it.
test.describe("cache-no-cache-bypass (production)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "build",
  });

  test("cached route is stable without the flag and re-executes with __no_cache", async ({
    request,
  }) => {
    const get = async (suffix = "") => {
      const res = await request.get(
        f.url("/cache-response-type/data/777" + suffix),
        { headers: { Accept: "application/json" } },
      );
      expect(res.status()).toBe(200);
      return await res.json();
    };

    // Warm the cache, then poll until a request returns the cached value.
    const first = await get();
    await expect
      .poll(async () => (await get()).ts, {
        timeout: 15000,
        message: "Expected /cache-response-type/data/777 to become cached",
      })
      .toBe(first.ts);

    // Baseline (caching works): without the flag the route serves a HIT —
    // a non-cached route would never produce a stable per-execution value.
    const cachedA = await get();
    const cachedB = await get();
    expect(cachedA.ts).toBe(first.ts);
    expect(cachedB.ts).toBe(first.ts);
    expect(cachedB.rand).toBe(first.rand);

    // Bypass: __no_cache re-executes the handler on every request. Assert on
    // `rand` (Math.random), not `ts` — two back-to-back requests can land in the
    // same millisecond and make a Date.now() inequality flake.
    const bypass1 = await get("?__no_cache");
    const bypass2 = await get("?__no_cache");
    expect(bypass1.rand).not.toBe(first.rand);
    expect(bypass2.rand).not.toBe(bypass1.rand);
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
    const beforeSecondVisit = f.proc().stdout().length;
    await page.goto(f.url("/cache-status/success"));
    await waitForHydration(page);
    await waitForCacheHit(f.proc(), beforeSecondVisit, "/cache-status/success");

    const secondRendered = await page
      .getByTestId("cache-status-success-rendered")
      .textContent();

    // The cache hit should keep the rendered timestamp stable on the page.
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
    expect(json1.type).toBe("json");
    expect(json1.id).toBe("42");

    // Poll until cache write completes and second request returns cached data
    await expect
      .poll(
        async () => {
          const res = await request.get(f.url("/cache-response-type/data/42"), {
            headers: { Accept: "application/json" },
          });
          const data = await res.json();
          return data.ts;
        },
        { timeout: 15000, message: "Expected cached JSON response for /42" },
      )
      .toBe(json1.ts);

    // Verify full cache hit (rand should also match)
    const jsonRes2 = await request.get(f.url("/cache-response-type/data/42"), {
      headers: { Accept: "application/json" },
    });
    expect(jsonRes2.status()).toBe(200);
    const json2 = await jsonRes2.json();
    expect(json2.rand).toBe(json1.rand);

    const textRes1 = await request.get(f.url("/cache-response-type/data/42"), {
      headers: { Accept: "text/plain" },
    });
    expect(textRes1.status()).toBe(200);
    const text1 = await textRes1.text();
    expect(text1).toContain("text:42:");

    const textTs = text1.split(":")[2];
    expect(textTs).not.toBe(String(json1.ts));
  });

  test("path.json with different params produce different cache entries", async ({
    request,
  }) => {
    const res1 = await request.get(f.url("/cache-response-type/data/alpha"), {
      headers: { Accept: "application/json" },
    });
    expect(res1.status()).toBe(200);
    const body1 = await res1.json();
    expect(body1.id).toBe("alpha");

    // Poll until cache write completes for alpha
    await expect
      .poll(
        async () => {
          const res = await request.get(
            f.url("/cache-response-type/data/alpha"),
            { headers: { Accept: "application/json" } },
          );
          const data = await res.json();
          return data.ts;
        },
        { timeout: 15000, message: "Expected cached JSON response for /alpha" },
      )
      .toBe(body1.ts);

    const res2 = await request.get(f.url("/cache-response-type/data/beta"), {
      headers: { Accept: "application/json" },
    });
    expect(res2.status()).toBe(200);
    const body2 = await res2.json();
    expect(body2.id).toBe("beta");
    expect(body2.ts).not.toBe(body1.ts);

    const res3 = await request.get(f.url("/cache-response-type/data/alpha"), {
      headers: { Accept: "application/json" },
    });
    expect(res3.status()).toBe(200);
    const body3 = await res3.json();
    expect(body3.ts).toBe(body1.ts);
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

    await expect
      .poll(
        async () => {
          await page.goto(f.url("/cache-test/react-node-cached"));
          await waitForHydration(page);
          const count = await page.getByTestId("rn-count").textContent();
          const ts = await page.getByTestId("rn-ts").textContent();
          return { count, ts };
        },
        {
          timeout: 15000,
          message: "Expected cached ReactNode payload on second visit",
        },
      )
      .toEqual({ count: firstCount, ts: firstTs });
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

  // Warm up isolated dev server to avoid first-request optimizer churn
  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    await page.goto(f.url("/"));
    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    await page.close();
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

    // Navigate away and back. The background cache write is async, so retry
    // until the cache is populated and returns the same count (cache hit).
    await page.goto(f.url("/"));
    await waitForHydration(page);

    await expect(async () => {
      await page.goto(f.url("/cache-test/null-cached"));
      await waitForHydration(page);

      await expect(page.getByTestId("null-value")).toHaveText("null");
      const secondCount = await page.getByTestId("null-count").textContent();

      // Cached: same count (loader did NOT run again)
      expect(secondCount).toBe(firstCount);
    }).toPass({ timeout: 10000, intervals: [1000, 2000, 3000] });
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

// ============================================================================
// Search params cache isolation (dev)
// ============================================================================

test.describe("cache-search-params-isolation (dev)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
    isolatedServer: true,
    cliOptions: { env: { INTERNAL_RANGO_DEBUG: "1" } },
  });

  test("same path with different search params should render different content", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // Visit without search params
    await page.goto(f.url("/cache-test/search-params"));
    await waitForHydration(page);
    await expect(page.getByTestId("search-page-value")).toHaveText("page:none");

    // Visit with ?page=1
    await page.goto(f.url("/cache-test/search-params?page=1"));
    await waitForHydration(page);
    await expect(page.getByTestId("search-page-value")).toHaveText("page:1");

    // Visit with ?page=2
    await page.goto(f.url("/cache-test/search-params?page=2"));
    await waitForHydration(page);
    await expect(page.getByTestId("search-page-value")).toHaveText("page:2");
  });

  test("client-side Link navigation between different search params should update content", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // Load page without params (document request, populates cache)
    await page.goto(f.url("/cache-test/search-params"));
    await waitForHydration(page);
    await expect(page.getByTestId("search-page-value")).toHaveText("page:none");

    // Client-side navigate to ?page=1 via Link click (partial navigation)
    await page.getByTestId("page-link-1").click();
    await expect(page.getByTestId("search-page-value")).toHaveText("page:1");

    // Client-side navigate to ?page=2 via Link click — must show page:2, not cached page:1
    await page.getByTestId("page-link-2").click();
    await expect(page.getByTestId("search-page-value")).toHaveText("page:2");
  });
});

// ============================================================================
// Search params cache isolation (production)
// ============================================================================

test.describe("cache-search-params-isolation (production)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "build",
    isolatedServer: true,
    cliOptions: { env: { INTERNAL_RANGO_DEBUG: "1" } },
  });

  test("same path with different search params should render different content", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/cache-test/search-params"));
    await waitForHydration(page);
    await expect(page.getByTestId("search-page-value")).toHaveText("page:none");

    await page.goto(f.url("/cache-test/search-params?page=1"));
    await waitForHydration(page);
    await expect(page.getByTestId("search-page-value")).toHaveText("page:1");

    await page.goto(f.url("/cache-test/search-params?page=2"));
    await waitForHydration(page);
    await expect(page.getByTestId("search-page-value")).toHaveText("page:2");
  });

  test("client-side Link navigation between different search params should update content", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/cache-test/search-params"));
    await waitForHydration(page);
    await expect(page.getByTestId("search-page-value")).toHaveText("page:none");

    // Client-side navigate via Link (partial navigation with _rsc_partial)
    await page.getByTestId("page-link-1").click();
    await expect(page.getByTestId("search-page-value")).toHaveText("page:1");

    await page.getByTestId("page-link-2").click();
    await expect(page.getByTestId("search-page-value")).toHaveText("page:2");
  });
});

// ============================================================================
// Tag invalidation: cacheTag() / cache({ tags }) / updateTag() (dev)
// ============================================================================

test.describe("cache-tag invalidation", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
    isolatedServer: true,
  });

  async function pollTs(request: any, path: string) {
    const res = await request.get(f.url(path), {
      headers: { Accept: "application/json" },
    });
    return (await res.json()).ts;
  }

  test('"use cache" + cacheTag: entries are cached and invalidated by tag', async ({
    request,
  }) => {
    const first = await pollTs(request, "/cache-tag-test/item/1");
    // Poll until the async cache write lands (stable ts == cached).
    await expect
      .poll(() => pollTs(request, "/cache-tag-test/item/1"), { timeout: 5000 })
      .toBe(first);

    const inv = await request.get(f.url("/cache-tag-test/invalidate/items"), {
      headers: { Accept: "application/json" },
    });
    expect(inv.status()).toBe(200);

    await expect
      .poll(() => pollTs(request, "/cache-tag-test/item/1"), { timeout: 5000 })
      .not.toBe(first);
  });

  test('"use cache" + cacheTag: a specific item tag invalidates only that item', async ({
    request,
  }) => {
    const a = await pollTs(request, "/cache-tag-test/item/a");
    const b = await pollTs(request, "/cache-tag-test/item/b");
    await expect
      .poll(() => pollTs(request, "/cache-tag-test/item/a"), { timeout: 5000 })
      .toBe(a);
    await expect
      .poll(() => pollTs(request, "/cache-tag-test/item/b"), { timeout: 5000 })
      .toBe(b);

    await request.get(f.url("/cache-tag-test/invalidate/item:a"), {
      headers: { Accept: "application/json" },
    });

    await expect
      .poll(() => pollTs(request, "/cache-tag-test/item/a"), { timeout: 5000 })
      .not.toBe(a);
    // Item b is untouched.
    expect(await pollTs(request, "/cache-tag-test/item/b")).toBe(b);
  });

  test("cache() DSL tags: entries are cached and invalidated by tag", async ({
    request,
  }) => {
    const first = await pollTs(request, "/cache-tag-test/catalog/x");
    await expect
      .poll(() => pollTs(request, "/cache-tag-test/catalog/x"), {
        timeout: 5000,
      })
      .toBe(first);

    await request.get(f.url("/cache-tag-test/invalidate/catalog"), {
      headers: { Accept: "application/json" },
    });

    await expect
      .poll(() => pollTs(request, "/cache-tag-test/catalog/x"), {
        timeout: 5000,
      })
      .not.toBe(first);
  });

  test("invalidating an unknown tag is a safe no-op", async ({ request }) => {
    const first = await pollTs(request, "/cache-tag-test/item/noop");
    await expect
      .poll(() => pollTs(request, "/cache-tag-test/item/noop"), {
        timeout: 5000,
      })
      .toBe(first);

    const inv = await request.get(
      f.url("/cache-tag-test/invalidate/nonexistent-tag-xyz"),
      { headers: { Accept: "application/json" } },
    );
    expect(inv.status()).toBe(200);

    // Unrelated entry still cached (same ts).
    expect(await pollTs(request, "/cache-tag-test/item/noop")).toBe(first);
  });

  test("revalidateTag invalidates a tagged entry in the background (not awaited)", async ({
    request,
  }) => {
    const first = await pollTs(request, "/cache-tag-test/item/rev");
    await expect
      .poll(() => pollTs(request, "/cache-tag-test/item/rev"), {
        timeout: 5000,
      })
      .toBe(first);

    // Fire-and-forget: revalidateTag returns before invalidation lands.
    const rev = await request.get(f.url("/cache-tag-test/revalidate/items"), {
      headers: { Accept: "application/json" },
    });
    expect(rev.status()).toBe(200);

    // Poll until the background invalidation makes the next read fresh.
    await expect
      .poll(() => pollTs(request, "/cache-tag-test/item/rev"), {
        timeout: 5000,
      })
      .not.toBe(first);
  });

  test("server action updateTag() invalidates a cached page segment", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/cache-tag-test/action-page"));
    await waitForHydration(page);
    const initialTs = await page.getByTestId("action-tag-ts").textContent();
    expect(initialTs).toMatch(/^\d+$/);

    // Poll until cached (revisit returns the same ts).
    await expect
      .poll(
        async () => {
          await page.goto(f.url("/cache-tag-test/action-page"));
          await waitForHydration(page);
          return page.getByTestId("action-tag-ts").textContent();
        },
        { timeout: 10000 },
      )
      .toBe(initialTs);

    await page.getByTestId("invalidate-tag-btn").click();
    await expect(page.getByTestId("invalidate-tag-result")).toBeVisible();

    await expect
      .poll(
        async () => {
          await page.goto(f.url("/cache-tag-test/action-page"));
          await waitForHydration(page);
          return page.getByTestId("action-tag-ts").textContent();
        },
        { timeout: 10000 },
      )
      .not.toBe(initialTs);
  });
});

// ============================================================================
// Tag invalidation (production)
// ============================================================================

test.describe("cache-tag invalidation (production)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "build",
    isolatedServer: true,
  });

  async function pollTs(request: any, path: string) {
    const res = await request.get(f.url(path), {
      headers: { Accept: "application/json" },
    });
    return (await res.json()).ts;
  }

  test('"use cache" + cacheTag: entries are cached and invalidated by tag', async ({
    request,
  }) => {
    const first = await pollTs(request, "/cache-tag-test/item/1");
    await expect
      .poll(() => pollTs(request, "/cache-tag-test/item/1"), { timeout: 5000 })
      .toBe(first);

    await request.get(f.url("/cache-tag-test/invalidate/items"), {
      headers: { Accept: "application/json" },
    });

    await expect
      .poll(() => pollTs(request, "/cache-tag-test/item/1"), { timeout: 5000 })
      .not.toBe(first);
  });

  test('"use cache" + cacheTag: a specific item tag invalidates only that item', async ({
    request,
  }) => {
    const a = await pollTs(request, "/cache-tag-test/item/a");
    const b = await pollTs(request, "/cache-tag-test/item/b");
    await expect
      .poll(() => pollTs(request, "/cache-tag-test/item/a"), { timeout: 5000 })
      .toBe(a);
    await expect
      .poll(() => pollTs(request, "/cache-tag-test/item/b"), { timeout: 5000 })
      .toBe(b);

    await request.get(f.url("/cache-tag-test/invalidate/item:a"), {
      headers: { Accept: "application/json" },
    });

    await expect
      .poll(() => pollTs(request, "/cache-tag-test/item/a"), { timeout: 5000 })
      .not.toBe(a);
    expect(await pollTs(request, "/cache-tag-test/item/b")).toBe(b);
  });

  test("cache() DSL tags: entries are cached and invalidated by tag", async ({
    request,
  }) => {
    const first = await pollTs(request, "/cache-tag-test/catalog/x");
    await expect
      .poll(() => pollTs(request, "/cache-tag-test/catalog/x"), {
        timeout: 5000,
      })
      .toBe(first);

    await request.get(f.url("/cache-tag-test/invalidate/catalog"), {
      headers: { Accept: "application/json" },
    });

    await expect
      .poll(() => pollTs(request, "/cache-tag-test/catalog/x"), {
        timeout: 5000,
      })
      .not.toBe(first);
  });

  test("invalidating an unknown tag is a safe no-op", async ({ request }) => {
    const first = await pollTs(request, "/cache-tag-test/item/noop");
    await expect
      .poll(() => pollTs(request, "/cache-tag-test/item/noop"), {
        timeout: 5000,
      })
      .toBe(first);

    const inv = await request.get(
      f.url("/cache-tag-test/invalidate/nonexistent-tag-xyz"),
      { headers: { Accept: "application/json" } },
    );
    expect(inv.status()).toBe(200);

    expect(await pollTs(request, "/cache-tag-test/item/noop")).toBe(first);
  });

  test("revalidateTag invalidates a tagged entry in the background (not awaited)", async ({
    request,
  }) => {
    const first = await pollTs(request, "/cache-tag-test/item/rev");
    await expect
      .poll(() => pollTs(request, "/cache-tag-test/item/rev"), {
        timeout: 5000,
      })
      .toBe(first);

    // Fire-and-forget: revalidateTag returns before invalidation lands.
    const rev = await request.get(f.url("/cache-tag-test/revalidate/items"), {
      headers: { Accept: "application/json" },
    });
    expect(rev.status()).toBe(200);

    // Poll until the background invalidation makes the next read fresh.
    await expect
      .poll(() => pollTs(request, "/cache-tag-test/item/rev"), {
        timeout: 5000,
      })
      .not.toBe(first);
  });

  test("server action updateTag() invalidates a cached page segment", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/cache-tag-test/action-page"));
    await waitForHydration(page);
    const initialTs = await page.getByTestId("action-tag-ts").textContent();

    await expect
      .poll(
        async () => {
          await page.goto(f.url("/cache-tag-test/action-page"));
          await waitForHydration(page);
          return page.getByTestId("action-tag-ts").textContent();
        },
        { timeout: 10000 },
      )
      .toBe(initialTs);

    await page.getByTestId("invalidate-tag-btn").click();
    await expect(page.getByTestId("invalidate-tag-result")).toBeVisible();

    await expect
      .poll(
        async () => {
          await page.goto(f.url("/cache-tag-test/action-page"));
          await waitForHydration(page);
          return page.getByTestId("action-tag-ts").textContent();
        },
        { timeout: 10000 },
      )
      .not.toBe(initialTs);
  });
});
