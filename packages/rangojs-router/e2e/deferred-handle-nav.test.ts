import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { expectNoPageError, testId, waitForHydration } from "./helper";

/**
 * Resolve-by-default deferred-handle navigation contract + the P1 history-cache
 * poisoning fix.
 *
 * Resolve-by-default:
 *   - SSR / full load: deferred handle values are resolved SERVER-SIDE, so the
 *     initial HTML already carries the resolved title + resolved breadcrumbs.
 *   - Soft nav: a handle with a deferred entry HOLDS its previous resolved value
 *     (the whole handle — the sync crumb is held alongside the deferred one)
 *     until every deferred value resolves, then swaps in the resolved set. The
 *     consumer never sees a Promise and never a per-crumb pending marker. The
 *     route's own sync CONTENT still commits immediately.
 *
 * P1 — history-cache poisoning (Meta, via the generalized resolve path):
 *   - Navigate to a deferred route, let its title resolve (cache holds the
 *     route's OWN title), navigate away, popstate BACK -> the route's own title.
 *   - Same-URL A -> B -> A: the abandoned first A must not clobber the second A.
 *
 * Assertions are event-driven (expect.poll / title waits / visibility).
 */

// Must match DEFER_DELAY in e2e/test-app/src/urls/deferred-handle-nav.tsx.
const DEFER_DELAY = 1500;
const RESOLVE_TIMEOUT = DEFER_DELAY + 6000;

function deferredHandleNavTests(mode: "dev" | "build") {
  const label = mode === "build" ? "production" : mode;

  test.describe(`deferred-handle-nav (${label})`, () => {
    const f = useFixture({ root: "./e2e/test-app", mode });

    test.setTimeout(40000);

    test("SSR full load resolves deferred values server-side (title + breadcrumbs present in initial render)", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      // Direct (full) load of the deferred route. The server resolves the
      // deferred Meta title AND the deferred .defer() breadcrumb before sending
      // the payload, so both are present without any client wait.
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

      // Soft-nav to the deferred route.
      await testId(page, "dh-to-deferred").click();

      // The route's own sync CONTENT commits immediately (it is route content,
      // not a handle, so the deferred handle hold does not delay it).
      await expect(testId(page, "dh-sync-content")).toBeVisible({
        timeout: 1200,
      });

      // The Breadcrumbs handle has a deferred entry, so its WHOLE value is held
      // at the previous route's breadcrumbs until it resolves: neither the sync
      // crumb nor the deferred crumb is visible yet, and there is no pending
      // marker (the consumer never sees a Promise).
      const nav = page.locator('[data-testid="resolved-trail-nav"]');
      await expect(nav).not.toContainText("DH Sync Crumb", { timeout: 1200 });
      await expect(nav).not.toContainText("DH Deferred Crumb");

      // Meta title likewise holds the previous value (SWR — never blanked).
      expect(
        await page.title(),
        "previous title kept while deferred values resolve",
      ).toBe("DH Nav Start");

      // Once the deep async component resolves the deferred crumb, the whole
      // breadcrumb set swaps in resolved: [..., DH Sync Crumb, DH Deferred Crumb].
      await expect(nav).toContainText("DH Sync Crumb", {
        timeout: RESOLVE_TIMEOUT,
      });
      await expect(nav).toContainText("DH Deferred Crumb");

      // ...and the deferred title lands.
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

      // Commit the deferred route, then navigate AWAY before its deferred values
      // resolve. The navigate-away aborts the RSC stream so the client promise
      // never resolves; the entry was marked stale + handlesPending while pending.
      await testId(page, "dh-to-deferred").click();
      await expect(testId(page, "dh-sync-content")).toBeVisible({
        timeout: 1200,
      });
      await testId(page, "dh-deferred-to-other").click();
      await expect(testId(page, "dh-other-page")).toBeVisible();
      await expect.poll(() => page.title()).toBe("DH Other");

      // Popstate back: the entry is stale + handlesPending, so it revalidates
      // with a FULL re-render — the route's OWN resolved title, never the seed.
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
  });
}

deferredHandleNavTests("dev");
deferredHandleNavTests("build");
