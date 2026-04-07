import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import {
  waitForHydration,
  expectNoPageError,
  expectNoReload,
  testId,
} from "./helper";

/**
 * Regression test: parallel slot loaders with revalidate(() => true) must
 * produce consistent segment IDs across fresh and revalidation code paths.
 *
 * Bug: resolveOrphanLayoutWithRevalidation passed undefined as shortCodeOverride
 * for parallel entry loaders, causing the parallel's own shortCode (e.g., L0P0)
 * to be used instead of the parent layout's shortCode (L0). This produced a
 * loader segment ID the client couldn't match, making useLoader() throw
 * "data not found in context" after client-side navigation.
 */

test.describe("parallel-loader-reval", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });

  test("parallel loader data is available on initial load", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/parallel-loader-reval/page-a"));
    await waitForHydration(page);

    await expect(testId(page, "reval-page-a")).toBeVisible();
    await expect(testId(page, "parallel-reval-count")).toBeVisible();
  });

  test("parallel loader data survives client-side navigation", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/parallel-loader-reval/page-a"));
    await waitForHydration(page);
    await using __ = await expectNoReload(page);

    await expect(testId(page, "reval-page-a")).toBeVisible();
    const initialCount = await testId(
      page,
      "parallel-reval-count",
    ).textContent();
    expect(Number(initialCount)).toBeGreaterThan(0);

    // Navigate to page B — the parallel loader revalidates
    await testId(page, "link-to-b").click();
    await expect(testId(page, "reval-page-b")).toBeVisible();

    // Parallel slot loader data must still be accessible (no error boundary)
    await expect(testId(page, "parallel-reval-count")).toBeVisible();
    const afterNavCount = await testId(
      page,
      "parallel-reval-count",
    ).textContent();
    // Count should have incremented (revalidate(() => true) re-runs the loader)
    expect(Number(afterNavCount)).toBeGreaterThan(Number(initialCount));
  });

  test("parallel loader data survives round-trip navigation", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/parallel-loader-reval/page-a"));
    await waitForHydration(page);
    await using __ = await expectNoReload(page);

    await expect(testId(page, "reval-page-a")).toBeVisible();

    // Navigate A → B → A
    await testId(page, "link-to-b").click();
    await expect(testId(page, "reval-page-b")).toBeVisible();
    await expect(testId(page, "parallel-reval-count")).toBeVisible();

    await testId(page, "link-to-a").click();
    await expect(testId(page, "reval-page-a")).toBeVisible();
    await expect(testId(page, "parallel-reval-count")).toBeVisible();
  });
});

test.describe("parallel-loader-reval (production)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "build",
  });

  test("parallel loader data is available on initial load in production", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/parallel-loader-reval/page-a"));
    await waitForHydration(page);

    await expect(testId(page, "reval-page-a")).toBeVisible();
    await expect(testId(page, "parallel-reval-count")).toBeVisible();
  });

  test("parallel loader data survives client-side navigation in production", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/parallel-loader-reval/page-a"));
    await waitForHydration(page);
    await using __ = await expectNoReload(page);

    await expect(testId(page, "reval-page-a")).toBeVisible();
    const initialCount = await testId(
      page,
      "parallel-reval-count",
    ).textContent();
    expect(Number(initialCount)).toBeGreaterThan(0);

    // Navigate to page B — the parallel loader revalidates
    await testId(page, "link-to-b").click();
    await expect(testId(page, "reval-page-b")).toBeVisible();

    // Parallel slot loader data must still be accessible (no error boundary)
    await expect(testId(page, "parallel-reval-count")).toBeVisible();
    const afterNavCount = await testId(
      page,
      "parallel-reval-count",
    ).textContent();
    expect(Number(afterNavCount)).toBeGreaterThan(Number(initialCount));
  });

  test("parallel loader data survives round-trip navigation in production", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/parallel-loader-reval/page-a"));
    await waitForHydration(page);
    await using __ = await expectNoReload(page);

    await expect(testId(page, "reval-page-a")).toBeVisible();

    // Navigate A → B → A
    await testId(page, "link-to-b").click();
    await expect(testId(page, "reval-page-b")).toBeVisible();
    await expect(testId(page, "parallel-reval-count")).toBeVisible();

    await testId(page, "link-to-a").click();
    await expect(testId(page, "reval-page-a")).toBeVisible();
    await expect(testId(page, "parallel-reval-count")).toBeVisible();
  });
});
