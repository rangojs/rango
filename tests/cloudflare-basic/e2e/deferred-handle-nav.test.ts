import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { expectNoPageError, testId, waitForHydration } from "./helper";

/**
 * Resolve-by-default deferred-handle navigation + the P1 history-cache poisoning
 * fix under the Cloudflare (workerd) runtime. Mirrors
 * packages/rangojs-router/e2e/deferred-handle-nav.test.ts so both apps pin the
 * same contracts (repo mandate: cover both apps, dev + production).
 *
 * Resolve-by-default:
 *   - SSR / full load: deferred handle values resolve SERVER-SIDE, so the initial
 *     HTML carries the resolved title + resolved breadcrumbs.
 *   - Soft nav: a handle with a deferred entry HOLDS its previous resolved value
 *     (the whole handle) until every deferred value resolves, then swaps in the
 *     resolved set. No Promise and no per-crumb pending marker reach the consumer.
 *     The route's own sync CONTENT still commits immediately.
 *
 * P1 — history-cache poisoning (Meta, via the generalized resolve path).
 */

// Must match DEFER_DELAY in
// tests/cloudflare-basic/src/pages/deferred-handle-nav.tsx.
const DEFER_DELAY = 1500;
const RESOLVE_TIMEOUT = DEFER_DELAY + 6000;

function deferredHandleNavTests(mode: "dev" | "build") {
  const label = mode === "build" ? "production" : "dev";

  test.describe(`deferred-handle-nav (${label})`, () => {
    const f = useFixture({ root: ".", mode });

    test.setTimeout(40000);

    test("SSR full load resolves deferred values server-side (title + breadcrumbs present in initial render)", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/dh-nav/deferred"));
      await expect.poll(() => page.title()).toBe("DH Deferred Title");

      const nav = page.locator('[data-testid="resolved-trail-nav"]');
      await expect(nav).toContainText("DH Sync Crumb");
      await expect(nav).toContainText("DH Deferred Crumb");
    });

    test("soft nav holds the previous breadcrumbs + title until the deferred values resolve, then swaps in the resolved set", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/dh-nav"));
      await waitForHydration(page);
      await expect.poll(() => page.title()).toBe("DH Nav Start");

      await testId(page, "dh-to-deferred").click();

      // Route's own sync content commits immediately.
      await expect(testId(page, "dh-sync-content")).toBeVisible({
        timeout: 1200,
      });

      // The Breadcrumbs handle holds its whole previous value (no sync crumb, no
      // deferred crumb, no pending marker) until the deferred value resolves.
      const nav = page.locator('[data-testid="resolved-trail-nav"]');
      await expect(nav).not.toContainText("DH Sync Crumb", { timeout: 1200 });
      await expect(nav).not.toContainText("DH Deferred Crumb");

      // Meta title holds the previous value.
      expect(
        await page.title(),
        "previous title kept while deferred values resolve",
      ).toBe("DH Nav Start");

      // Resolved swap.
      await expect(nav).toContainText("DH Sync Crumb", {
        timeout: RESOLVE_TIMEOUT,
      });
      await expect(nav).toContainText("DH Deferred Crumb");
      await expect
        .poll(() => page.title(), { timeout: RESOLVE_TIMEOUT })
        .toBe("DH Deferred Title");
    });

    test("P1: navigate away after the title resolves, popstate back restores the route's OWN title (not the previous seed)", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/dh-nav"));
      await waitForHydration(page);
      await expect.poll(() => page.title()).toBe("DH Nav Start");

      await testId(page, "dh-to-deferred").click();
      await expect(testId(page, "dh-sync-content")).toBeVisible();
      await expect
        .poll(() => page.title(), { timeout: RESOLVE_TIMEOUT })
        .toBe("DH Deferred Title");

      await testId(page, "dh-deferred-to-other").click();
      await expect(testId(page, "dh-other-page")).toBeVisible();
      await expect.poll(() => page.title()).toBe("DH Other");

      await page.goBack();
      await expect(testId(page, "dh-deferred-page")).toBeVisible();
      await expect
        .poll(() => page.title(), { timeout: RESOLVE_TIMEOUT })
        .toBe("DH Deferred Title");
    });

    test("P1: navigate away BEFORE the deferred values resolve, popstate back is still fresh (invalidate + revalidate)", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/dh-nav"));
      await waitForHydration(page);
      await expect.poll(() => page.title()).toBe("DH Nav Start");

      await testId(page, "dh-to-deferred").click();
      await expect(testId(page, "dh-sync-content")).toBeVisible({
        timeout: 1200,
      });
      await testId(page, "dh-deferred-to-other").click();
      await expect(testId(page, "dh-other-page")).toBeVisible();
      await expect.poll(() => page.title()).toBe("DH Other");

      await page.goBack();
      await expect(testId(page, "dh-deferred-page")).toBeVisible();
      await expect
        .poll(() => page.title(), { timeout: RESOLVE_TIMEOUT })
        .toBe("DH Deferred Title");
    });

    test("P1 same-URL: abandoning the first deferred visit does not clobber the second visit's title", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/dh-nav"));
      await waitForHydration(page);

      await testId(page, "dh-to-deferred").click();
      await expect(testId(page, "dh-sync-content")).toBeVisible({
        timeout: 1200,
      });
      await testId(page, "dh-deferred-to-other").click();
      await expect(testId(page, "dh-other-page")).toBeVisible();

      await testId(page, "dh-other-to-deferred").click();
      await expect(testId(page, "dh-deferred-page")).toBeVisible();

      await expect
        .poll(() => page.title(), { timeout: RESOLVE_TIMEOUT })
        .toBe("DH Deferred Title");
      await expect.poll(() => page.title()).toBe("DH Deferred Title");
    });

    test("action revalidation re-streams a deferred handle: the client holds the previous value, then swaps in the resolved one", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/dh-nav/action-deferred"));
      await waitForHydration(page);
      const nav = page.locator('[data-testid="resolved-trail-nav"]');
      // Full load resolved the deferred crumb SERVER-side at count 0.
      await expect(nav).toContainText("Action Crumb 0");

      // Trigger the server action (JS on): it bumps the cookie counter and the
      // route revalidates, so the action partial STREAMS the new deferred crumb
      // through the same processHandles client path as a soft nav.
      await testId(page, "dh-action-submit").click();

      // The sync body count (route content, NOT a handle) reflects the
      // revalidated render reading the action-bumped cookie — the route re-ran.
      await expect(testId(page, "dh-action-count")).toHaveText("1");

      // The client HOLDS the previous resolved crumb (SWR) while the streamed
      // deferred value is pending — not blanked, and the new value not yet landed.
      await expect(nav).toContainText("Action Crumb 0");

      // Once the streamed deferred crumb resolves client-side, it swaps in. This
      // is the regression guard for the action-revalidation instance-ordering fix
      // (cache-then-emit in server-action-bridge.ts) — before it, the resolved
      // value was dropped and the crumb held "Action Crumb 0" forever.
      await expect(nav).toContainText("Action Crumb 1", {
        timeout: RESOLVE_TIMEOUT,
      });
    });

    test.describe("no-JS progressive enhancement", () => {
      test.use({ javaScriptEnabled: false });

      test("PE form POST re-render resolves the deferred title server-side into the HTML", async ({
        page,
      }) => {
        // GET with JS off: the deferred title is resolved server-side at count 0.
        await page.goto(f.url("/dh-nav/action-deferred"));
        expect(await page.title()).toBe("Action Deferred Title 0");

        // Native form POST (no JS) -> progressive-enhancement re-render. The
        // action bumps the counter and the PE render resolves the NEW deferred
        // title SERVER-side, so the returned HTML carries the resolved title
        // (never a Promise) — exercising the progressive-enhancement.ts resolve
        // site that the JS-enabled full-render twin never reaches.
        await testId(page, "dh-action-submit").click();
        await expect
          .poll(() => page.title(), { timeout: RESOLVE_TIMEOUT })
          .toBe("Action Deferred Title 1");
      });
    });
  });
}

deferredHandleNavTests("dev");
deferredHandleNavTests("build");
