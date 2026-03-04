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

test.describe("Action sets cookie, loader reads via revalidation", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });

  test("loader sees cookie set by action via read-after-write revalidation", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // Visit the page — no cookie yet
    await page.goto(f.url("/loader-cookie/action-sets-cookie"));
    await waitForHydration(page);
    await expect(testId(page, "action-sets-cookie-page")).toBeVisible();
    await expect(testId(page, "mw-session-value")).toHaveText("no-session");

    // Trigger the action that calls cookies().set("mw-session", "action-set-value")
    await testId(page, "action-set-cookie-btn").click();

    // After action completes, the server revalidates. The loader re-runs and
    // sees the cookie via read-after-write (response stub merge).
    await expect(testId(page, "mw-session-value")).toHaveText(
      "action-set-value",
      { timeout: 10000 },
    );
  });
});

test.describe("Middleware reads cookie set by action", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });

  test("middleware sees cookie set by action during same-request revalidation", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/loader-cookie/mw-reads-cookie"));
    await waitForHydration(page);
    await expect(testId(page, "mw-reads-cookie-page")).toBeVisible();

    // Both middleware and loader see no cookie initially
    await expect(testId(page, "mw-session-from-middleware")).toHaveText(
      "no-session",
    );
    await expect(testId(page, "mw-session-from-loader")).toHaveText(
      "no-session",
    );

    // Action sets the cookie
    await testId(page, "action-set-cookie-btn").click();

    // Both the loader and route middleware should see the updated cookie during
    // the same revalidation pass after the action completes.
    await expect(testId(page, "mw-session-from-loader")).toHaveText(
      "action-set-value",
      { timeout: 10000 },
    );
    await expect(testId(page, "mw-session-from-middleware")).toHaveText(
      "action-set-value",
      { timeout: 10000 },
    );

    // The next full request should stay consistent.
    await page.reload();
    await waitForHydration(page);
    await expect(testId(page, "mw-session-from-middleware")).toHaveText(
      "action-set-value",
    );
    await expect(testId(page, "mw-session-from-loader")).toHaveText(
      "action-set-value",
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

test.describe("Middleware reads cookie set by action (production)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "build",
  });

  test("middleware sees cookie set by action during same-request revalidation in production", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/loader-cookie/mw-reads-cookie"));
    await waitForHydration(page);
    await expect(testId(page, "mw-reads-cookie-page")).toBeVisible();

    await expect(testId(page, "mw-session-from-middleware")).toHaveText(
      "no-session",
    );
    await expect(testId(page, "mw-session-from-loader")).toHaveText(
      "no-session",
    );

    await testId(page, "action-set-cookie-btn").click();

    await expect(testId(page, "mw-session-from-loader")).toHaveText(
      "action-set-value",
      { timeout: 10000 },
    );
    await expect(testId(page, "mw-session-from-middleware")).toHaveText(
      "action-set-value",
      { timeout: 10000 },
    );
  });
});

test.describe("Action sets cookie, loader reads via revalidation (production)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "build",
  });

  test("loader sees cookie set by action via read-after-write revalidation (production)", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/loader-cookie/action-sets-cookie"));
    await waitForHydration(page);
    await expect(testId(page, "action-sets-cookie-page")).toBeVisible();
    await expect(testId(page, "mw-session-value")).toHaveText("no-session");

    // Trigger the action
    await testId(page, "action-set-cookie-btn").click();

    // After action completes, revalidation re-runs the loader
    await expect(testId(page, "mw-session-value")).toHaveText(
      "action-set-value",
      { timeout: 10000 },
    );
  });
});
