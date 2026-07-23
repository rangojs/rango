import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration } from "./helper";

/**
 * Hardening: when a soft navigation receives a response it CANNOT process (an
 * undecodable Flight body, or any unanticipated failure building the response),
 * the FE must surface the route's error boundary -- not let the rejection become
 * an uncaught promise rejection that silently aborts the navigation.
 *
 * This must hold for prefetched responses too: a warm prefetch whose payload is
 * unprocessable rejects on consumption and funnels through the same navigation
 * catch as a fresh fetch.
 *
 * We synthesize an unprocessable response by fulfilling the partial fetch with a
 * 200 + garbage body (valid status, invalid Flight), so the RSC decoder rejects.
 * RootErrorBoundary renders the "Internal Server Error" fallback.
 */
const GARBAGE_BODY = "not-a-valid-flight-payload-@#$%^&*";

function fulfillGarbage(pathEndsWith: string) {
  return {
    predicate: (url: URL) =>
      url.pathname.endsWith(pathEndsWith) &&
      url.searchParams.has("_rsc_partial"),
    handler: async (route: import("@playwright/test").Route) => {
      await route.fulfill({
        status: 200,
        contentType: "text/x-component",
        body: GARBAGE_BODY,
      });
    },
  };
}

function describeUnprocessableNav(mode: "dev" | "build") {
  const label = mode === "build" ? "production" : "dev";

  test.describe(`unprocessable navigation response (${label})`, () => {
    const f = useFixture({ root: "./e2e/test-app", mode });

    test("a fresh unprocessable response triggers the error boundary", async ({
      page,
    }) => {
      // link-prefetch-none -> /blog/post-2 never prefetches, so this is a
      // genuinely fresh fetch.
      const g = fulfillGarbage("/blog/post-2");
      await page.route(g.predicate, g.handler);

      await page.goto(f.url("/link-behavior"));
      await waitForHydration(page);

      await page.locator('[data-testid="link-prefetch-none"]').click();

      await expect(page.getByText("Internal Server Error")).toBeVisible({
        timeout: 5000,
      });
    });

    test("a prefetched unprocessable response triggers the error boundary", async ({
      page,
    }) => {
      // Install the garbage fulfillment BEFORE navigating so the prefetch="render"
      // for /blog/post-1 (fired after hydration) warms a FAILED prefetch entry.
      const g = fulfillGarbage("/blog/post-1");
      await page.route(g.predicate, g.handler);

      await page.goto(f.url("/link-behavior"));
      await waitForHydration(page);

      // Clicking consumes the warm (failed) prefetch; its rejection must still
      // surface the boundary, not silently abort.
      await page.locator('[data-testid="link-prefetch-render"]').click();

      await expect(page.getByText("Internal Server Error")).toBeVisible({
        timeout: 5000,
      });
    });

    test("an unprocessable router.refresh() response triggers the error boundary", async ({
      page,
    }) => {
      await page.goto(f.url("/hook-tests/use-router"));
      await waitForHydration(page);

      // Install after load so the initial render succeeds; router.refresh()
      // re-fetches the current route's partial, which now returns garbage.
      const g = fulfillGarbage("/hook-tests/use-router");
      await page.route(g.predicate, g.handler);

      await page.locator('[data-testid="router-refresh-btn"]').click();

      await expect(page.getByText("Internal Server Error")).toBeVisible({
        timeout: 5000,
      });
    });
  });
}

describeUnprocessableNav("dev");
describeUnprocessableNav("build");
