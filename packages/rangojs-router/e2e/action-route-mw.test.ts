import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, testId } from "./helper";

/**
 * Action error-boundary render runs under route middleware (C3).
 *
 * The route's middleware sets X-Action-Route-Mw on the response. This test fires
 * a succeeding action AND a throwing action (which renders the error boundary)
 * and asserts the route-middleware header is present on BOTH action responses.
 *
 * Before the fix, executeServerAction built + returned the error-boundary
 * Response itself, bypassing route middleware — so the header was present on the
 * success response but ABSENT on the error-boundary response. The fix defers the
 * error render into the revalidation phase, which runs inside the same route-
 * middleware wrapper as the success revalidation. Dev + production.
 */
function defineSpec(label: string, mode: "dev" | "build") {
  test.describe(`action error boundary under route middleware (${label})`, () => {
    const f = useFixture({ root: "./e2e/test-app", mode });

    test("route-middleware header is present on BOTH success and error-boundary action responses", async ({
      page,
    }) => {
      await page.goto(f.url("/action-route-mw"));
      await waitForHydration(page);
      await expect(testId(page, "action-route-mw-page")).toBeVisible();

      // Success action: route middleware wraps the revalidation render, so the
      // header is on the action response. (Baseline — already worked.)
      const successResponsePromise = page.waitForResponse((resp) =>
        resp.url().includes("_rsc_action"),
      );
      await testId(page, "action-route-mw-success-btn").click();
      const successResponse = await successResponsePromise;
      expect(successResponse.headers()["x-action-route-mw"]).toBe("applied");

      // Throwing action: the error boundary renders. The header must ALSO be
      // present here — the C3 contract. Pre-fix this was undefined.
      const errorResponsePromise = page.waitForResponse((resp) =>
        resp.url().includes("_rsc_action"),
      );
      await testId(page, "action-route-mw-throw-btn").click();
      const errorResponse = await errorResponsePromise;
      expect(errorResponse.headers()["x-action-route-mw"]).toBe("applied");

      // Confirm the error boundary actually rendered (not the success path).
      await expect(
        testId(page, "action-route-mw-error-boundary"),
      ).toBeVisible();
    });
  });
}

defineSpec("dev", "dev");
defineSpec("production", "build");
