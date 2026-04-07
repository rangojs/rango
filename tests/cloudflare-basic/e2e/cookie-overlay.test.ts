import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError, testId } from "./helper";

// -- Dev mode --

test.describe("cookie overlay (dev)", () => {
  const f = useFixture({
    root: ".",
    mode: "dev",
  });

  test("middleware-set cookie visible to same-request loader", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/cookie-overlay"));
    await waitForHydration(page);

    // Middleware sets mw-overlay=from-middleware on the route.
    // The loader reads it in the same request via the overlay.
    await expect(testId(page, "mw-cookie")).toHaveText("from-middleware");
  });

  test("action sets cookie, revalidation loader reads it", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/cookie-overlay"));
    await waitForHydration(page);

    // Before action: no action-overlay cookie
    await expect(testId(page, "action-cookie")).toHaveText("none");

    // Click the action that sets action-overlay cookie
    await testId(page, "set-cookie-btn").click();

    // After revalidation, the loader should see the cookie set by the action
    await expect(testId(page, "action-cookie")).toHaveText("from-action", {
      timeout: 10000,
    });

    // The action also read the mw-overlay cookie (set by middleware in this
    // request) and returned it — verify the action saw it
    await expect(testId(page, "mw-read-by-action")).toHaveText(
      "from-middleware",
      { timeout: 10000 },
    );
  });

  test("action deletes cookie, revalidation loader sees it gone", async ({
    page,
    context,
  }) => {
    using _ = expectNoPageError(page);

    // Pre-set the to-delete cookie so it's sent with the request
    await context.addCookies([
      {
        name: "to-delete",
        value: "should-vanish",
        domain: "localhost",
        path: "/",
      },
    ]);

    await page.goto(f.url("/cookie-overlay"));
    await waitForHydration(page);

    // Before action: cookie exists
    await expect(testId(page, "deleted-cookie")).toHaveText("should-vanish");

    // Click the action that deletes to-delete cookie
    await testId(page, "delete-cookie-btn").click();

    // After revalidation, the loader should see the cookie as absent
    await expect(testId(page, "deleted-cookie")).toHaveText("none", {
      timeout: 10000,
    });
  });
});

// -- Production mode --

test.describe("cookie overlay (production)", () => {
  const f = useFixture({
    root: ".",
    mode: "build",
  });

  test("middleware-set cookie visible to same-request loader (production)", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/cookie-overlay"));
    await waitForHydration(page);

    await expect(testId(page, "mw-cookie")).toHaveText("from-middleware");
  });

  test("action sets cookie, revalidation loader reads it (production)", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/cookie-overlay"));
    await waitForHydration(page);

    await expect(testId(page, "action-cookie")).toHaveText("none");

    await testId(page, "set-cookie-btn").click();

    await expect(testId(page, "action-cookie")).toHaveText("from-action", {
      timeout: 10000,
    });

    await expect(testId(page, "mw-read-by-action")).toHaveText(
      "from-middleware",
      { timeout: 10000 },
    );
  });

  test("action deletes cookie, revalidation loader sees it gone (production)", async ({
    page,
    context,
  }) => {
    using _ = expectNoPageError(page);

    await context.addCookies([
      {
        name: "to-delete",
        value: "should-vanish",
        domain: "localhost",
        path: "/",
      },
    ]);

    await page.goto(f.url("/cookie-overlay"));
    await waitForHydration(page);

    await expect(testId(page, "deleted-cookie")).toHaveText("should-vanish");

    await testId(page, "delete-cookie-btn").click();

    await expect(testId(page, "deleted-cookie")).toHaveText("none", {
      timeout: 10000,
    });
  });
});
