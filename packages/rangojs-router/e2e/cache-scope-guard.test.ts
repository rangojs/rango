import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError } from "./helper";

/**
 * cache() scope guard tests — "least cacheable wins" policy.
 *
 * Validates full cycle:
 * - ctx.set(cacheableVar) inside cache() — allowed
 * - ctx.set(nonCacheableVar) inside cache() — allowed; ctx.get() throws
 * - ctx.set(var, val, { cache: false }) inside cache() — allowed; ctx.get() throws
 * - ctx.get(nonCacheableVar) inside cache() — throws (read guard)
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

  test("ctx.get(nonCacheable var) inside cache() should throw after set", async ({
    page,
  }) => {
    await page.goto(f.url("/cache-scope-guard/var-blocked"));
    await waitForHydration(page);

    await expect(page.getByTestId("csg-error-page")).toBeVisible();
    await expect(page.getByTestId("csg-error-message")).toContainText(
      "non-cacheable",
    );
  });

  test("ctx.get(var set with cache:false) inside cache() should throw", async ({
    page,
  }) => {
    await page.goto(f.url("/cache-scope-guard/write-blocked"));
    await waitForHydration(page);

    await expect(page.getByTestId("csg-error-page")).toBeVisible();
    await expect(page.getByTestId("csg-error-message")).toContainText(
      "non-cacheable",
    );
  });

  test("ctx.get(nonCacheable var) inside cache() should throw (read guard)", async ({
    page,
  }) => {
    await page.goto(f.url("/cache-scope-guard/read-blocked"));
    await waitForHydration(page);

    await expect(page.getByTestId("csg-error-page")).toBeVisible();
    await expect(page.getByTestId("csg-error-message")).toContainText(
      "non-cacheable",
    );
  });

  test("@meta parallel reading non-cacheable var inside cache() should throw", async ({
    page,
  }) => {
    await page.goto(f.url("/cache-scope-guard/parallel-read-blocked"));
    await waitForHydration(page);

    await expect(page.getByTestId("csg-error-page")).toBeVisible();
    await expect(page.getByTestId("csg-error-message")).toContainText(
      "non-cacheable",
    );
  });

  test("getRequestContext().get(nonCacheable) inside cache() should throw", async ({
    page,
  }) => {
    await page.goto(f.url("/cache-scope-guard/reqctx-read-blocked"));
    await waitForHydration(page);

    await expect(page.getByTestId("csg-error-page")).toBeVisible();
    await expect(page.getByTestId("csg-error-message")).toContainText(
      "non-cacheable",
    );
  });

  test("getRequestContext().header() inside cache() should throw", async ({
    page,
  }) => {
    await page.goto(f.url("/cache-scope-guard/reqctx-header-blocked"));
    await waitForHydration(page);

    await expect(page.getByTestId("csg-error-page")).toBeVisible();
    await expect(page.getByTestId("csg-error-message")).toContainText(
      "cache() boundary",
    );
  });

  test("loader reading non-cacheable var inside cache() should be allowed", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/cache-scope-guard/loader-read-allowed"));
    await waitForHydration(page);

    await expect(page.getByTestId("csg-loader-page")).toBeVisible();
    await expect(page.getByTestId("csg-loader-value")).toHaveText(
      "loader-session",
    );
  });

  test("async loader reading non-cacheable var after await should be allowed", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/cache-scope-guard/async-loader-read-allowed"));
    await waitForHydration(page);

    await expect(page.getByTestId("csg-async-loader-page")).toBeVisible();
    await expect(page.getByTestId("csg-async-loader-value")).toHaveText(
      "loader-session",
    );
  });

  test("loader calling cookies().set() inside cache() should be allowed", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/cache-scope-guard/loader-cookie-allowed"));
    await waitForHydration(page);

    await expect(page.getByTestId("csg-loader-cookie-page")).toBeVisible();
    await expect(page.getByTestId("csg-loader-cookie-value")).toHaveText(
      "cookie-written",
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

  test("cookies() read inside cache() should throw", async ({ page }) => {
    await page.goto(f.url("/cache-scope-guard/cookies-read-blocked"));
    await waitForHydration(page);

    await expect(page.getByTestId("csg-error-page")).toBeVisible();
    await expect(page.getByTestId("csg-error-message")).toContainText(
      "cache() boundary",
    );
  });

  test("headers() read inside cache() should throw", async ({ page }) => {
    await page.goto(f.url("/cache-scope-guard/headers-read-blocked"));
    await waitForHydration(page);

    await expect(page.getByTestId("csg-error-page")).toBeVisible();
    await expect(page.getByTestId("csg-error-message")).toContainText(
      "cache() boundary",
    );
  });

  test("cookies() read inside a loader within cache() should be allowed", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/cache-scope-guard/loader-cookies-allowed"));
    await waitForHydration(page);

    await expect(page.getByTestId("csg-loader-cookies-page")).toBeVisible();
    await expect(page.getByTestId("csg-loader-cookies-value")).toHaveText(
      "no-cookie",
    );
  });

  test("cookies() read inside cache() should throw (SSR)", async ({
    request,
  }) => {
    const response = await request.get(
      f.url("/cache-scope-guard/cookies-read-blocked"),
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

  test("ctx.get(nonCacheable var) inside cache() should render error boundary after set", async ({
    page,
  }) => {
    await page.goto(f.url("/cache-scope-guard/var-blocked"));
    await waitForHydration(page);
    await expect(page.getByTestId("csg-error-page")).toBeVisible();
  });

  test("ctx.get(var set with cache:false) inside cache() should render error boundary", async ({
    page,
  }) => {
    await page.goto(f.url("/cache-scope-guard/write-blocked"));
    await waitForHydration(page);
    await expect(page.getByTestId("csg-error-page")).toBeVisible();
  });

  test("ctx.get(nonCacheable var) inside cache() should render error boundary (read guard)", async ({
    page,
  }) => {
    await page.goto(f.url("/cache-scope-guard/read-blocked"));
    await waitForHydration(page);
    await expect(page.getByTestId("csg-error-page")).toBeVisible();
  });

  test("@meta parallel reading non-cacheable var inside cache() should render error boundary", async ({
    page,
  }) => {
    await page.goto(f.url("/cache-scope-guard/parallel-read-blocked"));
    await waitForHydration(page);
    await expect(page.getByTestId("csg-error-page")).toBeVisible();
  });

  test("loader reading non-cacheable var inside cache() should be allowed", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/cache-scope-guard/loader-read-allowed"));
    await waitForHydration(page);

    await expect(page.getByTestId("csg-loader-page")).toBeVisible();
    await expect(page.getByTestId("csg-loader-value")).toHaveText(
      "loader-session",
    );
  });

  test("async loader reading non-cacheable var after await should be allowed", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/cache-scope-guard/async-loader-read-allowed"));
    await waitForHydration(page);

    await expect(page.getByTestId("csg-async-loader-page")).toBeVisible();
    await expect(page.getByTestId("csg-async-loader-value")).toHaveText(
      "loader-session",
    );
  });

  test("loader calling cookies().set() inside cache() should be allowed", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/cache-scope-guard/loader-cookie-allowed"));
    await waitForHydration(page);

    await expect(page.getByTestId("csg-loader-cookie-page")).toBeVisible();
    await expect(page.getByTestId("csg-loader-cookie-value")).toHaveText(
      "cookie-written",
    );
  });

  test("getRequestContext().get(nonCacheable) inside cache() should render error boundary", async ({
    page,
  }) => {
    await page.goto(f.url("/cache-scope-guard/reqctx-read-blocked"));
    await waitForHydration(page);
    await expect(page.getByTestId("csg-error-page")).toBeVisible();
  });

  test("getRequestContext().header() inside cache() should render error boundary", async ({
    page,
  }) => {
    await page.goto(f.url("/cache-scope-guard/reqctx-header-blocked"));
    await waitForHydration(page);
    await expect(page.getByTestId("csg-error-page")).toBeVisible();
  });

  test("cookies() read inside cache() should render error boundary", async ({
    page,
  }) => {
    await page.goto(f.url("/cache-scope-guard/cookies-read-blocked"));
    await waitForHydration(page);
    await expect(page.getByTestId("csg-error-page")).toBeVisible();
  });

  test("headers() read inside cache() should render error boundary", async ({
    page,
  }) => {
    await page.goto(f.url("/cache-scope-guard/headers-read-blocked"));
    await waitForHydration(page);
    await expect(page.getByTestId("csg-error-page")).toBeVisible();
  });

  test("cookies() read inside a loader within cache() should be allowed", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/cache-scope-guard/loader-cookies-allowed"));
    await waitForHydration(page);

    await expect(page.getByTestId("csg-loader-cookies-page")).toBeVisible();
    await expect(page.getByTestId("csg-loader-cookies-value")).toHaveText(
      "no-cookie",
    );
  });
});
