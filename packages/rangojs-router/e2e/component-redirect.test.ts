import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { testId, waitForHydration } from "./helper";

/**
 * A `redirect()` thrown from a SERVER COMPONENT (not a handler, not a loader)
 * sends the visitor to the target, on both lanes:
 * - a document load of the gated route: the browser ends on the target, and no
 *   "Internal Server Error" page is shown;
 * - a click on a link to it: the client navigation ends on the target.
 *
 * The throw is caught by React's Flight renderer and reported through
 * `onError`, so the router carries the target in the error row's digest
 * (src/render-redirect.ts): `answerShellError` answers a 3xx when the shell
 * fails, `RootErrorBoundary` mounts `LoaderRedirect` otherwise.
 */
function componentRedirectTests(f: ReturnType<typeof useFixture>) {
  const target = /\/component-redirect\/target$/;

  test.describe("component-redirect", () => {
    test("a document load ends on the target, not on the error page", async ({
      page,
    }) => {
      await page.goto(f.url("/component-redirect/gated"));

      await expect(page).toHaveURL(target, { timeout: 10000 });
      await expect(testId(page, "component-redirect-target")).toBeVisible();
      await expect(page.getByText("Internal Server Error")).toHaveCount(0);
    });

    test("the document load is answered with the redirect's own 3xx", async ({
      request,
    }) => {
      const response = await request.get(f.url("/component-redirect/gated"), {
        maxRedirects: 0,
      });

      expect(response.status()).toBe(302);
      expect(response.headers()["location"]).toBe("/component-redirect/target");
    });

    test("a gate under a route that declares loading() answers the document and then replaces", async ({
      page,
      request,
    }) => {
      // The throw lands inside the streamed Suspense boundary: the document is
      // a 200 with the loading() fallback, and the browser makes the replace.
      const document = await request.get(f.url("/component-redirect/loading"), {
        maxRedirects: 0,
      });
      expect(document.status()).toBe(200);

      await page.goto(f.url("/component-redirect/loading"));

      await expect(page).toHaveURL(target, { timeout: 10000 });
      await expect(testId(page, "component-redirect-target")).toBeVisible();
      await expect(page.getByText("Internal Server Error")).toHaveCount(0);
    });
    test("a click on a link to it ends on the target", async ({ page }) => {
      await page.goto(f.url("/component-redirect"));
      await waitForHydration(page);

      await testId(page, "component-redirect-link").click();

      await expect(page).toHaveURL(target, { timeout: 10000 });
      await expect(testId(page, "component-redirect-target")).toBeVisible();
      await expect(page.getByText("Internal Server Error")).toHaveCount(0);
    });
  });
}

test.describe("component-redirect", () => {
  const f = useFixture({ root: "./e2e/test-app", mode: "dev" });
  componentRedirectTests(f);
});

test.describe("component-redirect (production)", () => {
  const f = useFixture({ root: "./e2e/test-app", mode: "build" });
  test.setTimeout(120000);
  componentRedirectTests(f);
});
