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
 * Tests verify behavior (MISS/HIT patterns) rather than log output,
 * since onResponse callbacks run outside the debug logging scope.
 *
 * Log patterns used (from CacheScope, runs inside ALS scope):
 * - [CacheScope] MISS: ... - Cache miss
 * - [CacheScope] HIT: ... - Cache hit
 * - [CacheScope] Cached: ... - Cache write for 200 responses
 */

test.describe("cache-status-behavior", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
    isolatedServer: true,
    cliOptions: { env: { INTERNAL_RANGO_DEBUG: "1" } },
  });

  /**
   * Helper to get cache-related log entries from server stdout.
   * Only checks CacheScope logs which run inside the ALS scope.
   */
  function getCacheLogs(stdout: string): {
    misses: string[];
    hits: string[];
    cached: string[];
  } {
    const lines = stdout.split("\n");
    return {
      misses: lines.filter((line) => line.includes("[CacheScope] MISS:")),
      hits: lines.filter((line) => line.includes("[CacheScope] HIT:")),
      cached: lines.filter((line) => line.includes("[CacheScope] Cached:")),
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
      "Cache Status: Success (200)",
    );

    // Wait for async cache write to complete (runs inside waitUntil, fire-and-forget in dev)
    await expect
      .poll(
        () => {
          const stdout = f.proc().stdout().substring(initialLength);
          return (
            stdout.includes("[CacheScope] Cached:") &&
            stdout.includes("/cache-status/success")
          );
        },
        {
          timeout: 5000,
          message:
            "Expected [CacheScope] Cached: log for /cache-status/success",
        },
      )
      .toBeTruthy();

    // Check logs
    const afterFirstStdout = f.proc().stdout();
    const firstLogs = getCacheLogs(afterFirstStdout.substring(initialLength));

    // Should have MISS (first visit)
    expect(
      firstLogs.misses.some((log) => log.includes("/cache-status/success")),
    ).toBeTruthy();

    // Should have Cached (200 response without errors)
    expect(
      firstLogs.cached.some((log) => log.includes("/cache-status/success")),
    ).toBeTruthy();
  });

  test("notFound() should return 404 and NOT be cached", async ({ page }) => {
    // notFound() throws DataNotFoundError which renders a notFoundBoundary
    // The HTTP status is set to 404

    const initialStdout = f.proc().stdout();
    const initialLength = initialStdout.length;

    // Visit not-found route
    await page.goto(f.url("/cache-status/not-found"));

    // Wait for response processing
    await page.waitForTimeout(500);

    // Check logs - should have MISS but no Cached (404 is never cached)
    const afterStdout = f.proc().stdout();
    const logs = getCacheLogs(afterStdout.substring(initialLength));

    expect(
      logs.misses.some((log) => log.includes("/cache-status/not-found")),
    ).toBeTruthy();

    // Should NOT have Cached (non-200 responses are skipped)
    expect(
      logs.cached.some((log) => log.includes("/cache-status/not-found")),
    ).toBeFalsy();
  });

  test("thrown error should return 500 and NOT be cached", async ({ page }) => {
    // Thrown error is caught by errorBoundary which renders a fallback
    // The HTTP status is set to 500

    const initialStdout = f.proc().stdout();
    const initialLength = initialStdout.length;

    // Visit server-error route
    await page.goto(f.url("/cache-status/server-error"));

    // Wait for response processing
    await page.waitForTimeout(500);

    // Check logs - should have MISS but no Cached (500 is never cached)
    const afterStdout = f.proc().stdout();
    const logs = getCacheLogs(afterStdout.substring(initialLength));

    expect(
      logs.misses.some((log) => log.includes("/cache-status/server-error")),
    ).toBeTruthy();

    // Should NOT have Cached (non-200 responses are skipped)
    expect(
      logs.cached.some((log) => log.includes("/cache-status/server-error")),
    ).toBeFalsy();
  });

  test("cached 200 should hit on second request", async ({ page }) => {
    using _ = expectNoPageError(page);

    const beforeFirstStdout = f.proc().stdout();
    const beforeFirstLen = beforeFirstStdout.length;

    // First visit - populate cache
    await page.goto(f.url("/cache-status/success"));
    await waitForHydration(page);

    // Wait for async cache write to complete before navigating away
    await expect
      .poll(
        () => {
          const stdout = f.proc().stdout().substring(beforeFirstLen);
          return (
            stdout.includes("[CacheScope] Cached:") &&
            stdout.includes("/cache-status/success")
          );
        },
        {
          timeout: 5000,
          message: "Expected cache write to complete for /cache-status/success",
        },
      )
      .toBeTruthy();

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
    const secondLogs = getCacheLogs(
      afterSecondStdout.substring(beforeSecondLen),
    );

    // Should have HIT (from cache)
    expect(
      secondLogs.hits.some((log) => log.includes("/cache-status/success")),
    ).toBeTruthy();

    // Should NOT have MISS
    expect(
      secondLogs.misses.some((log) => log.includes("/cache-status/success")),
    ).toBeFalsy();
  });

  test("notFound (404) should miss on every request (never cached)", async ({
    page,
  }) => {
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
    const secondLogs = getCacheLogs(
      afterSecondStdout.substring(beforeSecondLen),
    );

    // Should still have MISS (not cached from first request)
    expect(
      secondLogs.misses.some((log) => log.includes("/cache-status/not-found")),
    ).toBeTruthy();

    // Should NOT have HIT
    expect(
      secondLogs.hits.some((log) => log.includes("/cache-status/not-found")),
    ).toBeFalsy();
  });
});
