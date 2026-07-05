import { expect, test, type Page } from "@playwright/test";
import { useFixture } from "./fixture";
import {
  expectNoPageError,
  testId,
  waitForHydration,
  blockPrefetch,
} from "./helper";

/**
 * Proves that a raw <Suspense> placed inside a handler's render (NOT the loading()
 * DSL) streams during client navigation: the fallback appears, then the streamed
 * async server-component content replaces it. Covered for both navigation shapes:
 *
 * - CROSS-route: / -> /suspense-stream (fresh mount).
 * - SAME-route: /suspense-stream/a -> /suspense-stream/b (param change; the route
 *   subtree remounts on param-bearing key, so the fallback shows again and the
 *   NEW content resolves).
 * - DIRECT load: the fallback is part of the SSR-streamed HTML.
 *
 * The routes use NO loader and NO loading() — the only fallback is the in-render
 * <Suspense> (see e2e/test-app/src/urls/suspense-stream.tsx). The navigations are
 * COLD (no prefetch), so the async child is still pending at commit and the
 * fallback must show. (Warm/prefetched navigation is covered separately — there
 * the data is already resolved so no fallback flashes.)
 *
 * Soft-nav assertion: instead of a <head> meta probe (RSC reconciles <head>, which
 * would drop it), we stamp a window flag before navigating and assert it survives —
 * a full document reload would clear window, a soft navigation preserves it.
 */

// The /suspense-stream routes' async child resolves after this many ms (server).
const SUSPENSE_DELAY = 2000;
// The fallback must appear well before the content. Kept under SUSPENSE_DELAY so a
// held/awaited commit (no fallback) fails fast instead of flaking.
const FALLBACK_TIMEOUT = 1500;
// Generous upper bound for the streamed content to arrive after the delay.
const CONTENT_TIMEOUT = SUSPENSE_DELAY + 5000;

async function stampSoftNavProbe(page: Page) {
  await page.evaluate(() => {
    (window as unknown as { __softNav?: number }).__softNav = 1;
  });
}
async function expectSoftNav(page: Page) {
  const survived = await page.evaluate(
    () => (window as unknown as { __softNav?: number }).__softNav,
  );
  expect(survived, "navigation was soft (no full document reload)").toBe(1);
}

function suspenseStreamTests(mode: "dev" | "build") {
  const label = mode === "build" ? "production" : mode;

  test.describe(`suspense-stream (${label})`, () => {
    const f = useFixture({ root: "./e2e/test-app", mode });

    test.setTimeout(40000);

    test("cross-route nav streams the raw <Suspense> fallback, then resolves", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/"));
      await waitForHydration(page);
      await stampSoftNavProbe(page);

      await testId(page, "suspense-stream-link").click();

      // The page shell commits immediately; the async child is still pending, so
      // the raw <Suspense> fallback must be visible BEFORE the content resolves.
      await expect(testId(page, "suspense-stream-fallback")).toBeVisible({
        timeout: FALLBACK_TIMEOUT,
      });
      await expect(testId(page, "suspense-stream-content")).toBeHidden();

      // Then the streamed content replaces the fallback.
      await expect(testId(page, "suspense-stream-content")).toHaveText(
        "resolved",
        { timeout: CONTENT_TIMEOUT },
      );
      await expect(testId(page, "suspense-stream-fallback")).toBeHidden();
      await expectSoftNav(page);
    });

    test("a promise-valued Meta push does NOT block the route's <Suspense> fallback", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/"));
      await waitForHydration(page);
      await stampSoftNavProbe(page);

      // /suspense-stream-meta is identical to /suspense-stream but its handler also
      // does ctx.use(Meta)(promise.then(...)). That async meta descriptor must be
      // isolated in its own <Suspense> inside MetaTags — otherwise use() suspends
      // MetaTags (in <head>, above the route's <Suspense>) and holds the whole
      // document, suppressing the route fallback until the meta promise resolves.
      await testId(page, "suspense-stream-meta-link").click();

      // Fallback must still stream despite the pending meta promise.
      await expect(testId(page, "suspense-stream-fallback")).toBeVisible({
        timeout: FALLBACK_TIMEOUT,
      });
      await expect(testId(page, "suspense-stream-content")).toHaveText(
        "resolved",
        { timeout: CONTENT_TIMEOUT },
      );
      await expect(testId(page, "suspense-stream-fallback")).toBeHidden();

      // And the streamed title lands once its promise resolves.
      await expect
        .poll(() => page.title(), { timeout: CONTENT_TIMEOUT })
        .toContain("Streamed Title");
      await expectSoftNav(page);
    });

    test("a deferred Meta push keeps the previous title until it resolves (no blank)", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      // Start on a page with a DISTINCT (non-default) title.
      await page.goto(f.url("/blog/post-1"));
      await waitForHydration(page);
      await expect.poll(() => page.title()).toContain("Post post-1");

      // Soft-nav to a route whose title is a deferred Meta push.
      await testId(page, "blog-to-suspense-meta").click();

      // The route fallback still streams (deferred meta does not block it)...
      await expect(testId(page, "suspense-stream-fallback")).toBeVisible({
        timeout: FALLBACK_TIMEOUT,
      });
      // ...and crucially the PREVIOUS title is kept while the deferred meta
      // resolves — it must NOT blank out or revert to the layout default. (Before
      // the store-resolution fix, a stripped pre-apply blanked it for ~2s.)
      await page.waitForTimeout(700);
      expect(
        await page.title(),
        "previous title kept during deferred meta resolution",
      ).toContain("Post post-1");

      // Then the streamed content + the deferred title land.
      await expect(testId(page, "suspense-stream-content")).toHaveText(
        "resolved",
        { timeout: CONTENT_TIMEOUT },
      );
      await expect
        .poll(() => page.title(), { timeout: CONTENT_TIMEOUT })
        .toContain("Streamed Title");
    });

    test("handler promise → client use() content + deferred Meta from the same promise streams", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/"));
      await waitForHydration(page);
      await stampSoftNavProbe(page);

      // /plp-meta: a promise made in the handler is passed to a "use client"
      // component that use()s it under a raw <Suspense>, and the deferred Meta is
      // derived from the SAME promise. The fallback must stream and the content +
      // title must resolve — the deferred meta must not hold the streaming content.
      await testId(page, "plp-meta-link").click();

      await expect(testId(page, "plp-meta-loading")).toBeVisible({
        timeout: FALLBACK_TIMEOUT,
      });
      await expect(testId(page, "use-promise-content")).toHaveText(
        "PLP Meta Title",
        { timeout: CONTENT_TIMEOUT },
      );
      await expect
        .poll(() => page.title(), { timeout: CONTENT_TIMEOUT })
        .toContain("PLP Meta Title");
      await expectSoftNav(page);
    });

    test("a startTransition commit is NOT held by a deferred Meta that resolves after the content", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/"));
      await waitForHydration(page);

      // /plp-meta-tx commits through startTransition (transition() DSL — the same
      // commit path SWR uses on a revisit). Its content resolves at 2s; its Meta is
      // a SEPARATE, slower promise (5s). Without the store resolution the transition
      // waits for the suspending MetaTags too and the commit is held to ~5s. The
      // store resolution removes the meta from the transition's wait, so the content
      // must commit well before the meta resolves.
      const titleBefore = await page.title();
      await testId(page, "plp-meta-tx-link").click();

      await expect(testId(page, "use-promise-content")).toHaveText(
        "TX Content",
        {
          // Between the content (2s) and the slow meta (5s): a meta-held commit (~5s)
          // would blow this; a content-time commit (~2-3s) passes.
          timeout: 4000,
        },
      );
      // The contract: the commit did NOT await the meta. At content-commit time the
      // deferred title has NOT been applied yet — the previous title is still in
      // place (the meta resolves at 5s, off the critical path). If the commit had
      // awaited the meta, the title here would already be "TX Meta Title".
      expect(await page.title()).toBe(titleBefore);
      expect(await page.title()).not.toContain("TX Meta Title");
      // ...and the deferred title still lands afterwards (resolved, just not blocking).
      await expect
        .poll(() => page.title(), { timeout: CONTENT_TIMEOUT })
        .toContain("TX Meta Title");
    });

    test("same-route param nav re-streams the fallback, then resolves new content", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      // This pins the COLD same-route nav contract (fallback re-streams). A
      // completed default-on viewport prefetch of link-b would be adopted as
      // a fully-prefetched commit, which deliberately skips the fallback
      // (no-flash, #622) — keep the cache virgin so the nav streams live.
      await blockPrefetch(page);

      // Land on /a and wait for its content so the boundary is resolved first.
      await page.goto(f.url("/suspense-stream/a"));
      await waitForHydration(page);
      await expect(testId(page, "suspense-stream-content")).toHaveText(
        "resolved:a",
        { timeout: CONTENT_TIMEOUT },
      );
      await stampSoftNavProbe(page);

      // Same-route nav to /b: the param-bearing key remounts the route subtree.
      await testId(page, "suspense-stream-link-b").click();

      // The fallback shows again during the same-route commit...
      await expect(testId(page, "suspense-stream-fallback")).toBeVisible({
        timeout: FALLBACK_TIMEOUT,
      });
      // ...then the NEW content (resolved:b) replaces it.
      await expect(testId(page, "suspense-stream-content")).toHaveText(
        "resolved:b",
        { timeout: CONTENT_TIMEOUT },
      );
      await expect(testId(page, "suspense-stream-fallback")).toBeHidden();
      await expectSoftNav(page);
    });

    test("direct load streams the raw <Suspense> fallback in the SSR HTML", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      // Assert the fallback markup is present in the streamed SSR response (Fizz
      // emits the fallback first, then the resolved content later in the stream).
      const res = await page.request.get(f.url("/suspense-stream/x"));
      const html = await res.text();
      expect(html).toContain("suspense-stream-fallback");

      // And in the browser the content resolves after the delay.
      await page.goto(f.url("/suspense-stream/x"));
      await expect(testId(page, "suspense-stream-page")).toBeVisible();
      await expect(testId(page, "suspense-stream-content")).toHaveText(
        "resolved:x",
        { timeout: CONTENT_TIMEOUT },
      );
    });
  });
}

suspenseStreamTests("dev");
suspenseStreamTests("build");
