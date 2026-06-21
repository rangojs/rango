import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, testId } from "./helper";

/**
 * A client soft navigation must survive a response that carries a body AND a
 * null-body status (101/204/205/304), on the Cloudflare (workerd) runtime.
 *
 * The browser network layer can hand fetch() such a response even though the JS
 * `new Response(body, { status })` constructor rejects the pairing: a 304
 * stale-while-revalidate prefetch revalidated to Not Modified (body materialized
 * from cache), or a 204 stateless soft redirect. teeWithCompletion used to
 * reconstruct every navigation response via `new Response(body, { status })` to
 * tee its body, throwing "Response with null body status cannot have body" and
 * aborting the navigation -- the original bug report came from a workerd
 * storefront whose soft-navs stream deferred data.
 *
 * The pairing can't be built with the JS constructor, so we synthesize the
 * network-layer condition with Playwright route interception: fetch the genuine
 * Flight partial, then re-serve it with only the status overridden.
 */
function describeNullBodyStatusNav(mode: "dev" | "build") {
  const label = mode === "build" ? "production" : "dev";

  test.describe(`null-body-status soft navigation (${label})`, () => {
    const f = useFixture({ root: ".", mode });

    // 304 (cache revalidation) and 204 (soft redirect) are the two statuses the
    // framework's own paths surface with a body in the browser.
    for (const status of [304, 204]) {
      test(`soft navigation survives a ${status} status paired with a body`, async ({
        page,
      }) => {
        const nullBodyErrors: string[] = [];
        page.on("pageerror", (e) => {
          if (/null body status/i.test(e.message)) {
            nullBodyErrors.push(e.message);
          }
        });

        await page.goto(f.url("/"));
        await waitForHydration(page);
        await expect(testId(page, "home-page")).toBeVisible();

        // Override only the status of the about page's SPA partial fetch,
        // keeping the genuine Flight body + headers so it stays decodable.
        await page.route(
          (url) =>
            url.pathname.endsWith("/about") &&
            url.searchParams.has("_rsc_partial"),
          async (route) => {
            const real = await route.fetch();
            await route.fulfill({ response: real, status });
          },
        );

        // Soft-navigate (PUSH) to /about.
        await testId(page, "nav-about").click();

        // Guard present: the navigation completes and the page renders.
        await expect(page).toHaveURL(/\/about/);
        await expect(testId(page, "about-page")).toBeVisible();
        await expect(testId(page, "about-title")).toHaveText("About");

        // The illegal-Response-construction TypeError must never have fired.
        expect(nullBodyErrors).toEqual([]);
      });
    }
  });
}

describeNullBodyStatusNav("dev");
describeNullBodyStatusNav("build");
