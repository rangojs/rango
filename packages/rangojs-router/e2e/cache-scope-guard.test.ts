import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError } from "./helper";

/**
 * cache() scope guard tests.
 * Validates that response-level side effects throw inside cache() boundaries
 * while ctx.set() remains allowed.
 */

// ============================================================================
// Dev
// ============================================================================

test.describe("cache-scope-guard", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });

  test("ctx.set() inside cache() should be allowed", async ({ page }) => {
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

    // Error boundary catches the guard error
    await expect(page.getByTestId("csg-error-page")).toBeVisible();
    await expect(page.getByTestId("csg-error-message")).toContainText(
      "cache() boundary",
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

  test("ctx.set() inside cache() should be allowed", async ({ page }) => {
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

    // Error boundary catches the guard error (message sanitized in production)
    await expect(page.getByTestId("csg-error-page")).toBeVisible();
  });
});
