import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError, testId } from "./helper";

/**
 * Tests for cookie access via cookies() standalone API
 * and RequestContext reverse (getRequestContext().reverse()).
 *
 * Covers both dev and production modes.
 */
test.describe("Loader cookies()", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });

  test("should read cookies via cookies()", async ({ page, context }) => {
    using _ = expectNoPageError(page);

    // Set a test-session cookie before navigating
    await context.addCookies([
      {
        name: "test-session",
        value: "abc123",
        domain: "localhost",
        path: "/",
      },
    ]);

    await page.goto(f.url("/loader-cookie"));
    await waitForHydration(page);

    await expect(testId(page, "loader-cookie-page")).toBeVisible();
    await expect(testId(page, "loader-cookie-session")).toHaveText("abc123");
  });

  test("should return null when cookie is not set", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/loader-cookie"));
    await waitForHydration(page);

    await expect(testId(page, "loader-cookie-page")).toBeVisible();
    await expect(testId(page, "loader-cookie-session")).toHaveText(
      "no-session",
    );
  });

  test("should read cookie set by middleware", async ({ page }) => {
    using _ = expectNoPageError(page);

    // First visit - middleware sets visit-count=1
    await page.goto(f.url("/loader-cookie/from-middleware"));
    await waitForHydration(page);

    await expect(testId(page, "loader-cookie-mw-page")).toBeVisible();
    // Middleware sets visit-count=1, loader sees it in the same request
    // via response-derived read-after-write
    await expect(testId(page, "loader-cookie-mw-visit-count")).toHaveText("1");

    // Second visit - middleware increments to 2
    await page.goto(f.url("/loader-cookie/from-middleware"));
    await waitForHydration(page);

    await expect(testId(page, "loader-cookie-mw-visit-count")).toHaveText("2");
  });
});

test.describe("RequestContext reverse()", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });

  test("should resolve route names via getRequestContext().reverse() in server action", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/loader-cookie/reverse-test"));
    await waitForHydration(page);

    await expect(testId(page, "request-context-reverse-page")).toBeVisible();

    // Click the button to trigger the server action
    await testId(page, "request-context-reverse-btn").click();

    // Verify resolved URLs
    await expect(testId(page, "action-reverse-blog-index")).toContainText(
      "/blog",
    );
    await expect(testId(page, "action-reverse-blog-post")).toContainText(
      "/blog/from-action",
    );
    await expect(testId(page, "action-reverse-href-index")).toContainText(
      "/href",
    );
  });
});

// === Production mode tests ===

test.describe("Loader cookies() (production)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "build",
  });

  test("should read cookies via cookies() in production", async ({
    page,
    context,
  }) => {
    using _ = expectNoPageError(page);

    await context.addCookies([
      {
        name: "test-session",
        value: "prod-session",
        domain: "localhost",
        path: "/",
      },
    ]);

    await page.goto(f.url("/loader-cookie"));
    await waitForHydration(page);

    await expect(testId(page, "loader-cookie-page")).toBeVisible();
    await expect(testId(page, "loader-cookie-session")).toHaveText(
      "prod-session",
    );
  });

  test("should return null when cookie is not set in production", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/loader-cookie"));
    await waitForHydration(page);

    await expect(testId(page, "loader-cookie-page")).toBeVisible();
    await expect(testId(page, "loader-cookie-session")).toHaveText(
      "no-session",
    );
  });

  test("should read cookie set by middleware in production", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // First visit
    await page.goto(f.url("/loader-cookie/from-middleware"));
    await waitForHydration(page);

    await expect(testId(page, "loader-cookie-mw-page")).toBeVisible();
    // Middleware sets visit-count=1, loader sees it in the same request
    await expect(testId(page, "loader-cookie-mw-visit-count")).toHaveText("1");

    // Second visit - middleware increments to 2
    await page.goto(f.url("/loader-cookie/from-middleware"));
    await waitForHydration(page);

    await expect(testId(page, "loader-cookie-mw-visit-count")).toHaveText("2");
  });
});

test.describe("RequestContext reverse() (production)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "build",
  });

  test("should resolve route names via getRequestContext().reverse() in production", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/loader-cookie/reverse-test"));
    await waitForHydration(page);

    await expect(testId(page, "request-context-reverse-page")).toBeVisible();

    // Click the button to trigger the server action
    await testId(page, "request-context-reverse-btn").click();

    // Verify resolved URLs
    await expect(testId(page, "action-reverse-blog-index")).toContainText(
      "/blog",
    );
    await expect(testId(page, "action-reverse-blog-post")).toContainText(
      "/blog/from-action",
    );
    await expect(testId(page, "action-reverse-href-index")).toContainText(
      "/href",
    );
  });
});
