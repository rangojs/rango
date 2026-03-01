import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError } from "./helper";

/**
 * Action redirect revalidation tests.
 *
 * Tests that after a server action sets a cookie and throws redirect(),
 * the target route's loaders revalidate with fresh data instead of
 * serving stale cached content.
 *
 * Bug: navigation-bridge passes _skipCache=true after action redirect,
 * but partial-update falls back to stale currentSegmentIds without
 * marking them as stale (_rsc_stale=true), so the server skips
 * revalidating loaders.
 */
test.describe("action-redirect-revalidation", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });

  test("loader revalidates after action redirect with cookie change", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // 1. Visit the main page — should show "Guest" (no auth cookie)
    await page.goto(f.url("/action-redirect-revalidation"));
    await waitForHydration(page);

    await expect(page.locator('[data-testid="auth-guest"]')).toBeVisible();

    // 2. Navigate to login page via client-side link
    await page.locator('[data-testid="go-to-login"]').click();
    await expect(
      page.locator('[data-testid="action-redirect-login-page"]'),
    ).toBeVisible();

    // 3. Fill in email and submit (action sets cookie + throws redirect)
    await page.locator('[data-testid="login-email"]').fill("test@test.com");
    await page.locator('[data-testid="login-submit"]').click();

    // 4. Should redirect back to main page
    await expect(page).toHaveURL(/\/action-redirect-revalidation$/);

    // 5. Main page should show authenticated content (fresh loader data)
    await expect(page.locator('[data-testid="auth-user"]')).toBeVisible();
    await expect(page.locator('[data-testid="auth-user"]')).toHaveText(
      "Logged in as: test@test.com",
    );
  });

  test("loader revalidates with _rsc_stale param after action redirect", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // Track RSC navigation requests to verify _rsc_stale and empty segments
    const rscRequests: { url: string; hasStale: boolean; segments: string }[] =
      [];
    page.on("request", (request) => {
      const url = request.url();
      if (url.includes("_rsc_partial=true")) {
        const parsed = new URL(url);
        rscRequests.push({
          url,
          hasStale: url.includes("_rsc_stale=true"),
          segments: parsed.searchParams.get("_rsc_segments") || "",
        });
      }
    });

    // Visit main page and navigate to login
    await page.goto(f.url("/action-redirect-revalidation"));
    await waitForHydration(page);
    await page.locator('[data-testid="go-to-login"]').click();
    await expect(
      page.locator('[data-testid="action-redirect-login-page"]'),
    ).toBeVisible();

    // Clear tracked requests before the action
    rscRequests.length = 0;

    // Submit login form (triggers action redirect)
    await page.locator('[data-testid="login-email"]').fill("user@example.com");
    await page.locator('[data-testid="login-submit"]').click();

    // Wait for redirect to complete
    await expect(page).toHaveURL(/\/action-redirect-revalidation$/);
    await expect(page.locator('[data-testid="auth-user"]')).toBeVisible();

    // Verify the RSC navigation request after action redirect
    const redirectNavRequest = rscRequests.find((r) =>
      r.url.includes("/action-redirect-revalidation"),
    );
    expect(redirectNavRequest).toBeTruthy();
    // Should send _rsc_stale=true as a signal
    expect(redirectNavRequest!.hasStale).toBe(true);
    // Should send empty segments so server renders everything fresh
    expect(redirectNavRequest!.segments).toBe("");
  });
});

/**
 * Production build tests for action redirect revalidation
 */
test.describe("action-redirect-revalidation (production)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "build",
  });

  test.setTimeout(120000);

  test("loader revalidates after action redirect with cookie change in production", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // Visit main page — should show "Guest"
    await page.goto(f.url("/action-redirect-revalidation"));
    await waitForHydration(page);
    await expect(page.locator('[data-testid="auth-guest"]')).toBeVisible();

    // Navigate to login page
    await page.locator('[data-testid="go-to-login"]').click();
    await expect(
      page.locator('[data-testid="action-redirect-login-page"]'),
    ).toBeVisible();

    // Submit login form
    await page.locator('[data-testid="login-email"]').fill("test@test.com");
    await page.locator('[data-testid="login-submit"]').click();

    // Should redirect and show authenticated content
    await expect(page).toHaveURL(/\/action-redirect-revalidation$/);
    await expect(page.locator('[data-testid="auth-user"]')).toBeVisible();
    await expect(page.locator('[data-testid="auth-user"]')).toHaveText(
      "Logged in as: test@test.com",
    );
  });

  test("_rsc_stale param is sent after action redirect in production", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    const rscRequests: { url: string; hasStale: boolean; segments: string }[] =
      [];
    page.on("request", (request) => {
      const url = request.url();
      if (url.includes("_rsc_partial=true")) {
        const parsed = new URL(url);
        rscRequests.push({
          url,
          hasStale: url.includes("_rsc_stale=true"),
          segments: parsed.searchParams.get("_rsc_segments") || "",
        });
      }
    });

    await page.goto(f.url("/action-redirect-revalidation"));
    await waitForHydration(page);
    await page.locator('[data-testid="go-to-login"]').click();
    await expect(
      page.locator('[data-testid="action-redirect-login-page"]'),
    ).toBeVisible();

    rscRequests.length = 0;

    await page.locator('[data-testid="login-email"]').fill("user@example.com");
    await page.locator('[data-testid="login-submit"]').click();

    await expect(page).toHaveURL(/\/action-redirect-revalidation$/);
    await expect(page.locator('[data-testid="auth-user"]')).toBeVisible();

    const redirectNavRequest = rscRequests.find((r) =>
      r.url.includes("/action-redirect-revalidation"),
    );
    expect(redirectNavRequest).toBeTruthy();
    expect(redirectNavRequest!.hasStale).toBe(true);
    expect(redirectNavRequest!.segments).toBe("");
  });
});
