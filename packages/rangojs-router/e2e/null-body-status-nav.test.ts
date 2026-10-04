import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, blockPrefetch, isPrefetchRequest } from "./helper";

/**
 * A client soft navigation must survive a response that carries a body AND a
 * null-body status (101/204/205/304).
 *
 * The browser network layer can legally hand fetch() such a response even though
 * the JS `new Response(body, { status })` constructor rejects the pairing:
 *   - 304: a stale-while-revalidate prefetch revalidated to Not Modified, with
 *     the body materialized from the HTTP/prefetch cache.
 *   - 204: a stateless soft redirect (createSimpleRedirectResponse).
 *
 * teeWithCompletion used to reconstruct every navigation response through
 * `new Response(body, { status: response.status })` to tee its body, which threw
 * "Response with null body status cannot have body" and aborted the navigation,
 * making streaming/deferred soft-navs intermittently fail.
 *
 * The condition can't be produced with the JS constructor (server or client), so
 * we synthesize it the same way the real bug arises -- at the network layer.
 * Playwright's route.fulfill goes through CDP at the network level (like the
 * browser cache), so it can pair a null-body status with a body. We fetch the
 * genuine Flight partial, then re-serve it with only the status overridden.
 */
function describeNullBodyStatusNav(mode: "dev" | "build") {
  const label = mode === "build" ? "production" : "dev";

  test.describe(`null-body-status soft navigation (${label})`, () => {
    const f = useFixture({ root: "./e2e/test-app", mode });

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

        // The blog index's bare post links viewport-prefetch by default. A
        // completed prefetch of /blog/post-1 would be adopted by the click
        // below and the overridden-status fetch this test exists to exercise
        // would never happen — block prefetch before load.
        await blockPrefetch(page);

        await page.goto(f.url("/blog"));
        await waitForHydration(page);
        await expect(
          page.locator('[data-testid="blog-index-page"]'),
        ).toBeVisible();

        // Override only the status of the post's SPA partial fetch, keeping the
        // genuine Flight body + headers. The Flight body stays decodable, so a
        // working guard lets the post render; the old code throws on the tee.
        await page.route(
          (url) =>
            url.pathname.endsWith("/blog/post-1") &&
            url.searchParams.has("_rsc_partial"),
          async (route) => {
            // This later-registered handler shadows blockPrefetch for this
            // URL; keep prefetches dead so only the click's real fetch gets
            // the overridden status.
            if (isPrefetchRequest(route.request())) {
              return route.abort("aborted");
            }
            const real = await route.fetch();
            await route.fulfill({ response: real, status });
          },
        );

        // Soft-navigate (PUSH) to the post.
        await page.locator('[data-testid="blog-post-link-1"]').click();

        // Guard present: the navigation completes and the post renders.
        await expect(
          page.locator('[data-testid="blog-post-page"]'),
        ).toBeVisible();
        await expect(
          page.locator('[data-testid="blog-post-title"]'),
        ).toHaveText("Post: post-1");
        await expect(page).toHaveURL(/\/blog\/post-1$/);

        // The illegal-Response-construction TypeError must never have fired.
        expect(nullBodyErrors).toEqual([]);
      });
    }
  });
}

describeNullBodyStatusNav("dev");
describeNullBodyStatusNav("build");
