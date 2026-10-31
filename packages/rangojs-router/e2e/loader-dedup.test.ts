import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError, testId } from "./helper";

/**
 * The parallel-loader-inherit route has a loader on the route and a child
 * layout with parallel slots. The layout's copy of the route's loader is
 * needed only when the route renders a loading() fallback: without one the
 * slot reads the route's own copy, and the copy is never resolved
 * (inheritedCopyRedundant, router/segment-resolution/revalidation.ts).
 *
 * The dev suite reads the loader segments the server renders from the
 * INTERNAL_RANGO_DEBUG=1 "renderSegments start" log, which names each
 * segment as `'<id>:loader'`.
 */

/** The distinct ParallelInheritLoader segment ids rendered in `output`. */
function renderedInheritLoaderIds(output: string): Set<string> {
  return new Set(
    Array.from(
      output.matchAll(/'([A-Z0-9]+D\d+\.[^']*#ParallelInheritLoader):loader'/g),
      (m) => m[1],
    ),
  );
}

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

  test("non-loading route never resolves the inherited loader copy", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // Snapshot stdout before navigation so we only assert on new output
    const before = f.proc().stdout().length;

    await page.goto(f.url("/parallel-loader-inherit"));
    await waitForHydration(page);

    await expect(testId(page, "parallel-loader-page")).toBeVisible();
    await expect(testId(page, "parallel-loader-data")).toHaveText(
      "route-level:inherited-data",
    );

    // Only the route's own copy is rendered.
    await expect
      .poll(
        () => renderedInheritLoaderIds(f.proc().stdout().slice(before)).size,
        { timeout: 5000 },
      )
      .toBe(1);
  });

  test("loading() route keeps the inherited loader copy", async ({ page }) => {
    using _ = expectNoPageError(page);

    const before = f.proc().stdout().length;

    await page.goto(f.url("/parallel-loader-inherit-loading"));
    await waitForHydration(page);

    await expect(testId(page, "parallel-loader-page-loading")).toBeVisible();
    await expect(testId(page, "parallel-loader-data")).toHaveText(
      "route-level:inherited-data",
    );

    // The route's own copy and the layout's.
    await expect
      .poll(
        () => renderedInheritLoaderIds(f.proc().stdout().slice(before)).size,
        { timeout: 5000 },
      )
      .toBe(2);
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
