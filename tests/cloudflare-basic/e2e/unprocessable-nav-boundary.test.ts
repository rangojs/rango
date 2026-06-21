import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, testId } from "./helper";

/**
 * Hardening on the Cloudflare (workerd) runtime: a soft navigation that receives
 * a response it CANNOT process (an undecodable Flight body) must surface the
 * route's error boundary, not become an uncaught rejection that silently aborts
 * the navigation. The navigation bridge is shared client source, so the same
 * chokepoint covers fresh and prefetched responses; the test-app suite covers
 * the prefetched variant deterministically.
 *
 * We synthesize the unprocessable response by fulfilling the partial fetch with
 * a 200 + garbage body so the RSC decoder rejects; RootErrorBoundary renders the
 * "Internal Server Error" fallback.
 */
function describeUnprocessableNav(mode: "dev" | "build") {
  const label = mode === "build" ? "production" : "dev";

  test.describe(`unprocessable navigation response (${label})`, () => {
    const f = useFixture({ root: ".", mode });

    test("an unprocessable response triggers the error boundary", async ({
      page,
    }) => {
      // Install BEFORE navigating so any default prefetch of /about also gets the
      // garbage body -- the navigation then hits an unprocessable response whether
      // it fetches fresh or consumes a warm (failed) prefetch.
      await page.route(
        (url) =>
          url.pathname.endsWith("/about") &&
          url.searchParams.has("_rsc_partial"),
        async (route) => {
          await route.fulfill({
            status: 200,
            contentType: "text/x-component",
            body: "not-a-valid-flight-payload-@#$%^&*",
          });
        },
      );

      await page.goto(f.url("/"));
      await waitForHydration(page);
      await expect(testId(page, "home-page")).toBeVisible();

      await testId(page, "nav-about").click();

      await expect(page.getByText("Internal Server Error")).toBeVisible({
        timeout: 5000,
      });
    });
  });
}

describeUnprocessableNav("dev");
describeUnprocessableNav("build");
