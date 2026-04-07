import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError, testId } from "./helper";

/**
 * Tests that inherited loader segments are deduplicated in the RSC stream.
 *
 * The parallel-loader-inherit route has a loader on the route and a child
 * layout with parallel slots. Without dedup, the loader is resolved twice
 * (route + inherited layout) and both copies are sent to the client.
 * With dedup, only the route copy is sent (unless loading() is present).
 *
 * We verify dedup by checking server logs (INTERNAL_RANGO_DEBUG=1 emits
 * "deduped N inherited loader segment(s)" when it fires).
 */

// ── Dev mode ─────────────────────────────────────────────────────────────

test.describe("loader-dedup (dev)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
    isolatedServer: true,
    cliOptions: {
      env: { INTERNAL_RANGO_DEBUG: "1" },
    },
  });

  test("non-loading route deduplicates inherited loader", async ({ page }) => {
    using _ = expectNoPageError(page);

    // Snapshot stdout before navigation so we only assert on new output
    const before = f.proc().stdout().length;

    await page.goto(f.url("/parallel-loader-inherit"));
    await waitForHydration(page);

    await expect(testId(page, "parallel-loader-page")).toBeVisible();
    await expect(testId(page, "parallel-loader-data")).toHaveText(
      "route-level:inherited-data",
    );

    // Poll for the dedup log in the new stdout slice
    await expect
      .poll(() => f.proc().stdout().slice(before), { timeout: 5000 })
      .toContain("deduped 1 inherited loader segment");
  });

  test("loading() route keeps inherited loader (no dedup)", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    const before = f.proc().stdout().length;

    await page.goto(f.url("/parallel-loader-inherit-loading"));
    await waitForHydration(page);

    await expect(testId(page, "parallel-loader-page-loading")).toBeVisible();
    await expect(testId(page, "parallel-loader-data")).toHaveText(
      "route-level:inherited-data",
    );

    // Give the server a moment to flush logs, then verify no dedup fired
    await page.waitForTimeout(500);
    const newOutput = f.proc().stdout().slice(before);
    expect(newOutput).not.toContain("deduped");
  });
});

// ── Production mode ──────────────────────────────────────────────────────

test.describe("loader-dedup (production)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "build",
  });

  test("parallel slot works with deduped loader in production", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/parallel-loader-inherit"));
    await waitForHydration(page);

    await expect(testId(page, "parallel-loader-page")).toBeVisible();
    await expect(testId(page, "parallel-loader-data")).toHaveText(
      "route-level:inherited-data",
    );
  });

  test("loading() variant works in production", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/parallel-loader-inherit-loading"));
    await waitForHydration(page);

    await expect(testId(page, "parallel-loader-page-loading")).toBeVisible();
    await expect(testId(page, "parallel-loader-data")).toHaveText(
      "route-level:inherited-data",
    );
  });
});
