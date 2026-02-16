import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError } from "./helper";

/**
 * Tests that middleware defined on a layout is applied to routes
 * inside an include() that is the only child of that layout.
 *
 * This validates the hasRoutesInItem fix: include() items must be
 * treated as containing routes so the parent layout is not
 * misclassified as orphan (which would clear its parent pointer
 * and break the middleware chain).
 */
test.describe("include-layout-middleware", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });

  test("layout middleware applies to included index route", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    const responsePromise = page.waitForResponse(
      (response) =>
        response.url().includes("/include-mw-test") &&
        response.status() === 200,
    );

    await page.goto(f.url("/include-mw-test"));
    const response = await responsePromise;
    await waitForHydration(page);

    // Layout middleware set the header
    expect(response.headers()["x-include-layout-middleware"]).toBe("applied");

    // Layout rendered
    await expect(
      page.locator('[data-testid="include-mw-layout-marker"]'),
    ).toHaveText("Layout Active");

    // Handler received the middleware-set variable
    await expect(
      page.locator('[data-testid="include-mw-layout-value"]'),
    ).toHaveText("Layout middleware: applied");
  });

  test("layout middleware applies to included detail route with params", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    const responsePromise = page.waitForResponse(
      (response) =>
        response.url().includes("/include-mw-test/abc-123") &&
        response.status() === 200,
    );

    await page.goto(f.url("/include-mw-test/abc-123"));
    const response = await responsePromise;
    await waitForHydration(page);

    // Layout middleware set the header
    expect(response.headers()["x-include-layout-middleware"]).toBe("applied");

    // Layout rendered
    await expect(
      page.locator('[data-testid="include-mw-layout-marker"]'),
    ).toHaveText("Layout Active");

    // Handler received the middleware-set variable
    await expect(
      page.locator('[data-testid="include-mw-detail-layout-value"]'),
    ).toHaveText("Layout middleware: applied");

    // Route params work correctly
    await expect(
      page.locator('[data-testid="include-mw-detail-title"]'),
    ).toHaveText("Detail: abc-123");
  });

  test("global middleware also applies alongside layout middleware", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    const responsePromise = page.waitForResponse(
      (response) =>
        response.url().includes("/include-mw-test") &&
        response.status() === 200,
    );

    await page.goto(f.url("/include-mw-test"));
    const response = await responsePromise;

    // Both global middleware (from router.use()) and layout middleware applied
    expect(response.headers()["x-global-middleware"]).toBe("applied");
    expect(response.headers()["x-include-layout-middleware"]).toBe("applied");
  });
});
