import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError } from "./helper";

/**
 * cache() scope guard tests.
 * Validates "least cacheable wins" policy:
 * - ctx.set(cacheableVar) inside cache() — allowed
 * - ctx.set(nonCacheableVar) inside cache() — throws (var-level policy)
 * - ctx.set(var, val, { cache: false }) inside cache() — throws (write-level)
 * - ctx.headers.set() inside cache() — throws (response-level)
 */

// ============================================================================
// Dev
// ============================================================================

test.describe("cache-scope-guard", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });

  test("ctx.set(cacheable var) inside cache() should be allowed", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/cache-scope-guard/set-allowed"));
    await waitForHydration(page);

    await expect(page.getByTestId("csg-set-page")).toBeVisible();
    await expect(page.getByTestId("csg-set-value")).toHaveText(
      "from-cached-handler",
    );
  });

  test("ctx.headers.set() inside cache() should throw", async ({ page }) => {
    await page.goto(f.url("/cache-scope-guard/header-blocked"));
    await waitForHydration(page);

    await expect(page.getByTestId("csg-error-page")).toBeVisible();
    await expect(page.getByTestId("csg-error-message")).toContainText(
      "cache() boundary",
    );
  });

  test("ctx.set(nonCacheable var) inside cache() should throw", async ({
    page,
  }) => {
    await page.goto(f.url("/cache-scope-guard/var-blocked"));
    await waitForHydration(page);

    await expect(page.getByTestId("csg-error-page")).toBeVisible();
    await expect(page.getByTestId("csg-error-message")).toContainText(
      "non-cacheable",
    );
  });

  test("ctx.set(var, val, { cache: false }) inside cache() should throw", async ({
    page,
  }) => {
    await page.goto(f.url("/cache-scope-guard/write-blocked"));
    await waitForHydration(page);

    await expect(page.getByTestId("csg-error-page")).toBeVisible();
    await expect(page.getByTestId("csg-error-message")).toContainText(
      "non-cacheable",
    );
  });

  test("ctx.headers.set() inside cache() should throw (SSR)", async ({
    request,
  }) => {
    const response = await request.get(
      f.url("/cache-scope-guard/header-blocked"),
      { headers: { Accept: "text/html,application/xhtml+xml" } },
    );
    const html = await response.text();
    expect(html).toContain("cache() boundary");
  });
});

// ============================================================================
// Production
// ============================================================================

test.describe("cache-scope-guard (production)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "build",
  });

  test("ctx.set(cacheable var) inside cache() should be allowed", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/cache-scope-guard/set-allowed"));
    await waitForHydration(page);

    await expect(page.getByTestId("csg-set-page")).toBeVisible();
    await expect(page.getByTestId("csg-set-value")).toHaveText(
      "from-cached-handler",
    );
  });

  test("ctx.headers.set() inside cache() should render error boundary", async ({
    page,
  }) => {
    await page.goto(f.url("/cache-scope-guard/header-blocked"));
    await waitForHydration(page);

    await expect(page.getByTestId("csg-error-page")).toBeVisible();
  });

  test("ctx.set(nonCacheable var) inside cache() should render error boundary", async ({
    page,
  }) => {
    await page.goto(f.url("/cache-scope-guard/var-blocked"));
    await waitForHydration(page);

    await expect(page.getByTestId("csg-error-page")).toBeVisible();
  });

  test("ctx.set(var, val, { cache: false }) inside cache() should render error boundary", async ({
    page,
  }) => {
    await page.goto(f.url("/cache-scope-guard/write-blocked"));
    await waitForHydration(page);

    await expect(page.getByTestId("csg-error-page")).toBeVisible();
  });
});
