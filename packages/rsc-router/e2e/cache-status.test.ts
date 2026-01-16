import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError } from "./helper";

/**
 * Tests that validate cache status behavior.
 *
 * HTTP status codes are set properly:
 * - 404 for notFound() segments
 * - 500 for error boundary segments
 * - 200 for successful responses
 *
 * Cache is skipped for non-200 responses via onResponse callback.
 *
 * Log patterns:
 * - [CacheScope] Cached: ... - Cache write for 200 responses
 * - [CacheStore] Skipping cache: non-200 status 404 ... - Skip cache for notFound
 * - [CacheStore] Skipping cache: non-200 status 500 ... - Skip cache for errors
 */

test.describe("cache-status-behavior", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });

  /**
   * Helper to get cache-related log entries from server stdout
   */
  function getCacheLogs(stdout: string): {
    misses: string[];
    hits: string[];
    cached: string[];
    skipped404: string[];
    skipped500: string[];
  } {
    const lines = stdout.split("\n");
    return {
      misses: lines.filter((line) => line.includes("[CacheScope] MISS:")),
      hits: lines.filter((line) => line.includes("[CacheScope] HIT:")),
      cached: lines.filter((line) => line.includes("[CacheScope] Cached:")),
      skipped404: lines.filter((line) => line.includes("[CacheStore] Skipping cache: non-200 status 404")),
      skipped500: lines.filter((line) => line.includes("[CacheStore] Skipping cache: non-200 status 500")),
    };
  }

  test("200 response should be cached", async ({ page }) => {
    using _ = expectNoPageError(page);

    const initialStdout = f.proc().stdout();
    const initialLength = initialStdout.length;

    // Visit success route - should return 200 and be cached
    await page.goto(f.url("/cache-status/success"));
    await waitForHydration(page);

    // Verify page content
    await expect(page.getByTestId("cache-status-success-title")).toHaveText(
      "Cache Status: Success (200)"
    );

    // Wait for cache write to complete
    await page.waitForTimeout(500);

    // Check logs
    const afterFirstStdout = f.proc().stdout();
    const firstLogs = getCacheLogs(afterFirstStdout.substring(initialLength));

    // Should have MISS (first visit)
    expect(
      firstLogs.misses.some((log) => log.includes("/cache-status/success"))
    ).toBeTruthy();

    // Should have Cached (200 response without errors)
    expect(
      firstLogs.cached.some((log) => log.includes("/cache-status/success"))
    ).toBeTruthy();

    // Should NOT have any skip logs
    expect(
      firstLogs.skipped404.some((log) => log.includes("/cache-status/success"))
    ).toBeFalsy();
    expect(
      firstLogs.skipped500.some((log) => log.includes("/cache-status/success"))
    ).toBeFalsy();
  });

  test("notFound() should return 404 and NOT be cached", async ({ page }) => {
    // notFound() throws DataNotFoundError which renders a notFoundBoundary
    // The HTTP status is set to 404

    const initialStdout = f.proc().stdout();
    const initialLength = initialStdout.length;

    // Visit not-found route
    await page.goto(f.url("/cache-status/not-found"));

    // Wait for response and cache decision
    await page.waitForTimeout(500);

    // Check logs
    const afterStdout = f.proc().stdout();
    const logs = getCacheLogs(afterStdout.substring(initialLength));

    // Should have MISS (first visit)
    expect(
      logs.misses.some((log) => log.includes("/cache-status/not-found"))
    ).toBeTruthy();

    // Should have skipped due to 404 status
    expect(
      logs.skipped404.some((log) => log.includes("/cache-status/not-found"))
    ).toBeTruthy();

    // Should NOT have Cached
    expect(
      logs.cached.some((log) => log.includes("/cache-status/not-found"))
    ).toBeFalsy();
  });

  test("thrown error should return 500 and NOT be cached", async ({ page }) => {
    // Thrown error is caught by errorBoundary which renders a fallback
    // The HTTP status is set to 500

    const initialStdout = f.proc().stdout();
    const initialLength = initialStdout.length;

    // Visit server-error route
    await page.goto(f.url("/cache-status/server-error"));

    // Wait for response and cache decision
    await page.waitForTimeout(500);

    // Check logs
    const afterStdout = f.proc().stdout();
    const logs = getCacheLogs(afterStdout.substring(initialLength));

    // Should have MISS (first visit)
    expect(
      logs.misses.some((log) => log.includes("/cache-status/server-error"))
    ).toBeTruthy();

    // Should have skipped due to 500 status
    expect(
      logs.skipped500.some((log) => log.includes("/cache-status/server-error"))
    ).toBeTruthy();

    // Should NOT have Cached
    expect(
      logs.cached.some((log) => log.includes("/cache-status/server-error"))
    ).toBeFalsy();
  });

  test("cached 200 should hit on second request", async ({ page }) => {
    using _ = expectNoPageError(page);

    // First visit - populate cache
    await page.goto(f.url("/cache-status/success"));
    await waitForHydration(page);
    await page.waitForTimeout(500);

    // Navigate away
    await page.goto(f.url("/"));
    await waitForHydration(page);

    // Record stdout before second visit
    const beforeSecondStdout = f.proc().stdout();
    const beforeSecondLen = beforeSecondStdout.length;

    // Second visit - should hit cache
    await page.goto(f.url("/cache-status/success"));
    await waitForHydration(page);

    // Check logs
    const afterSecondStdout = f.proc().stdout();
    const secondLogs = getCacheLogs(afterSecondStdout.substring(beforeSecondLen));

    // Should have HIT (from cache)
    expect(
      secondLogs.hits.some((log) => log.includes("/cache-status/success"))
    ).toBeTruthy();

    // Should NOT have MISS
    expect(
      secondLogs.misses.some((log) => log.includes("/cache-status/success"))
    ).toBeFalsy();
  });

  test("notFound (404) should miss on every request (never cached)", async ({ page }) => {
    // First visit
    await page.goto(f.url("/cache-status/not-found"));
    await page.waitForTimeout(500);

    // Navigate away (to a working page)
    await page.goto(f.url("/"));
    await waitForHydration(page);

    // Record stdout before second visit
    const beforeSecondStdout = f.proc().stdout();
    const beforeSecondLen = beforeSecondStdout.length;

    // Second visit - should still be MISS (404 responses are never cached)
    await page.goto(f.url("/cache-status/not-found"));
    await page.waitForTimeout(500);

    // Check logs
    const afterSecondStdout = f.proc().stdout();
    const secondLogs = getCacheLogs(afterSecondStdout.substring(beforeSecondLen));

    // Should still have MISS (not cached from first request)
    expect(
      secondLogs.misses.some((log) => log.includes("/cache-status/not-found"))
    ).toBeTruthy();

    // Should NOT have HIT
    expect(
      secondLogs.hits.some((log) => log.includes("/cache-status/not-found"))
    ).toBeFalsy();

    // Should still have skipped due to 404 status
    expect(
      secondLogs.skipped404.some((log) => log.includes("/cache-status/not-found"))
    ).toBeTruthy();
  });
});
