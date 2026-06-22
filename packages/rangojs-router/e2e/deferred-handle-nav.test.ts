import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { expectNoPageError, testId, waitForHydration } from "./helper";

/**
 * #622 follow-ups, exercised through CLIENT (soft) navigation:
 *
 * P2 — scoping deferred-handle store resolution to Meta:
 *   - A deferred Meta must NOT delay SYNCHRONOUS Breadcrumbs / sync content.
 *   - While the deferred Meta resolves, the PREVIOUS title is kept (no blank).
 *   - A deferred NON-Meta handle (a .defer() breadcrumb) reaches the consumer AS
 *     A PROMISE during soft nav (the consumer renders a "pending" marker), then
 *     resolves — proving the DeferredHandleEntry contract still holds on soft nav.
 *
 * P1 — history-cache poisoning:
 *   - Navigate to a deferred-Meta route, wait for its Meta to resolve (cache now
 *     holds the route's OWN title), navigate away, popstate BACK -> the restored
 *     title is the route's OWN, never the previous page's seed.
 *   - Same-URL A -> B -> A: the first A is abandoned mid-flight; the second A's
 *     title must win (no cross-nav clobber from the abandoned visit).
 *
 * Assertions are event-driven (expect.poll / title waits / visibility), never
 * fixed sleeps.
 */

// Must match DEFER_DELAY in e2e/test-app/src/urls/deferred-handle-nav.tsx.
const DEFER_DELAY = 1500;
const RESOLVE_TIMEOUT = DEFER_DELAY + 6000;

function deferredHandleNavTests(mode: "dev" | "build") {
  const label = mode === "build" ? "production" : mode;

  test.describe(`deferred-handle-nav (${label})`, () => {
    const f = useFixture({ root: "./e2e/test-app", mode });

    test.setTimeout(40000);

    test("P2: deferred Meta does not delay sync content/breadcrumb; previous title kept; deferred crumb arrives as a promise then resolves", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      // Start on a page with a DISTINCT sync title.
      await page.goto(f.url("/dh-nav"));
      await waitForHydration(page);
      await expect.poll(() => page.title()).toBe("DH Nav Start");

      // Soft-nav to the deferred route.
      await testId(page, "dh-to-deferred").click();

      // Sync content + sync breadcrumb commit IMMEDIATELY (not held by the
      // deferred Meta). A deferred-Meta-blocked apply would delay these.
      await expect(testId(page, "dh-sync-content")).toBeVisible({
        timeout: 1200,
      });
      await expect(
        page.locator('[data-testid="deferred-pending-nav"]'),
      ).toContainText("DH Sync Crumb", { timeout: 1200 });

      // The deferred (.defer()) breadcrumb reaches the consumer AS A PROMISE:
      // the pending marker for the not-yet-resolved entry is observable. The
      // crumbs are: [0] Home (layout), [1] DH Sync Crumb (route, sync),
      // [2] the deferred .defer() crumb -> its pending marker.
      await expect(testId(page, "crumb-pending-2")).toBeVisible({
        timeout: 1200,
      });

      // Meanwhile the PREVIOUS title is kept (SWR) — never blanked/reverted while
      // the deferred Meta resolves.
      expect(
        await page.title(),
        "previous title kept during deferred meta resolution",
      ).toBe("DH Nav Start");

      // Then the deferred crumb resolves (pending marker gone, label present)...
      await expect(
        page.locator('[data-testid="deferred-pending-nav"]'),
      ).toContainText("DH Deferred Crumb", { timeout: RESOLVE_TIMEOUT });
      await expect(testId(page, "crumb-pending-1")).toBeHidden();

      // ...and the deferred title lands.
      await expect
        .poll(() => page.title(), { timeout: RESOLVE_TIMEOUT })
        .toBe("DH Deferred Title");
    });

    test("P1: navigate away after the deferred Meta resolves, popstate back restores the route's OWN title (not the previous seed)", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/dh-nav"));
      await waitForHydration(page);
      await expect.poll(() => page.title()).toBe("DH Nav Start");

      // Go to the deferred route and WAIT for its Meta to resolve (the live-page
      // path writes the route's own title into the cache entry).
      await testId(page, "dh-to-deferred").click();
      await expect(testId(page, "dh-sync-content")).toBeVisible();
      await expect
        .poll(() => page.title(), { timeout: RESOLVE_TIMEOUT })
        .toBe("DH Deferred Title");

      // Navigate away to a route with a distinct title.
      await testId(page, "dh-deferred-to-other").click();
      await expect(testId(page, "dh-other-page")).toBeVisible();
      await expect.poll(() => page.title()).toBe("DH Other");

      // Popstate BACK: the restored title must be the deferred route's OWN
      // resolved title, not the "DH Nav Start" seed the entry was created with.
      await page.goBack();
      await expect(testId(page, "dh-deferred-page")).toBeVisible();
      await expect
        .poll(() => page.title(), { timeout: RESOLVE_TIMEOUT })
        .toBe("DH Deferred Title");
    });

    test("P1: navigate away BEFORE the deferred Meta resolves, popstate back is still fresh (invalidate + revalidate)", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/dh-nav"));
      await waitForHydration(page);
      await expect.poll(() => page.title()).toBe("DH Nav Start");

      // Go to deferred, but navigate AWAY as soon as the page commits — before
      // the deferred Meta (DEFER_DELAY) has resolved. The previous title is still
      // in place at this point (proven by the P2 test). The navigate-away ABORTS
      // the RSC stream, so the server's pending Meta never streams and the
      // client's deferred-Meta promise never resolves: the entry was marked STALE
      // while pending and stays stale.
      await testId(page, "dh-to-deferred").click();
      await expect(testId(page, "dh-sync-content")).toBeVisible({
        timeout: 1200,
      });
      await testId(page, "dh-deferred-to-other").click();
      await expect(testId(page, "dh-other-page")).toBeVisible();
      await expect.poll(() => page.title()).toBe("DH Other");

      // Popstate back ONCE (a single history step lands on the deferred entry;
      // repeating goBack would walk further back). The entry is stale and
      // handlesPending, so popstate serves the carry then REVALIDATES with a FULL
      // re-render: the handler re-runs and the deferred Meta re-streams, producing
      // the route's OWN resolved title — never the "DH Nav Start" seed. Poll the
      // title to let the background revalidation land.
      await page.goBack();
      await expect(testId(page, "dh-deferred-page")).toBeVisible();
      await expect
        .poll(() => page.title(), { timeout: RESOLVE_TIMEOUT })
        .toBe("DH Deferred Title");
    });

    test("P1 same-URL: abandoning the first deferred visit does not let it clobber the second visit's title", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/dh-nav"));
      await waitForHydration(page);

      // First visit to the deferred route (A), then immediately to other (B),
      // abandoning A's deferred Meta before it resolves.
      await testId(page, "dh-to-deferred").click();
      await expect(testId(page, "dh-sync-content")).toBeVisible({
        timeout: 1200,
      });
      await testId(page, "dh-deferred-to-other").click();
      await expect(testId(page, "dh-other-page")).toBeVisible();

      // Second visit to the SAME deferred URL (A again) via a fresh forward nav.
      await testId(page, "dh-other-to-deferred").click();
      await expect(testId(page, "dh-deferred-page")).toBeVisible();

      // The second visit's deferred Meta resolves; its title must win. The first
      // (abandoned) visit's late resolution must NOT clobber it — the token guard
      // ensures the stale visit does not write the live nav's state.
      await expect
        .poll(() => page.title(), { timeout: RESOLVE_TIMEOUT })
        .toBe("DH Deferred Title");

      // And it stays correct (the abandoned visit's resolution, if it fires
      // later, is dropped by the token guard rather than reverting the title).
      await expect.poll(() => page.title()).toBe("DH Deferred Title");
    });
  });
}

deferredHandleNavTests("dev");
deferredHandleNavTests("build");
