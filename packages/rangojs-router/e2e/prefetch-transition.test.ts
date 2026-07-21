import { expect, test, type Page } from "@playwright/test";
import { useFixture } from "./fixture";
import { expectNoPageError, testId, waitForHydration } from "./helper";

/**
 * Prefetch-aware transition contract.
 *
 * A navigation should only suppress its fallback/skeleton when the data is
 * ALREADY available client-side; otherwise it must stream the fallback so the
 * click has visible feedback. The matrix this pins:
 *
 *  - cold nav                          -> stream fallback/skeleton
 *  - partially-prefetched (in-flight)  -> stream fallback/skeleton (NOT held)
 *  - fully-prefetched (stream drained) -> forceAwait the ROUTER loaders + commit
 *                                         inside a bare startTransition: nothing
 *                                         flashes; a CLIENT component that
 *                                         suspends during its first render under
 *                                         an already-revealed boundary HOLDS the
 *                                         old content until it resolves
 *  - FE history-cache hit (popstate)   -> no flash (resolved-before-commit)
 *
 * History of the fully-prefetched row: #622 committed in startTransition, #624
 * reverted to a normal commit so client mount-suspense revealed the persistent
 * boundary's fallback, then the transition commit was reinstated as the
 * deliberate trade-off — on a warm nav, holding the old content beats flashing
 * a skeleton, and the client component's render happens pre-commit inside the
 * transition (its effects cannot run first). Boundaries newly mounted by the
 * nav still reveal their fallbacks (React shows new boundaries inside
 * transitions); only already-revealed boundaries hold.
 *
 * Flash detection uses a MutationObserver on addedNodes so even a single-frame
 * fallback that is added then immediately removed is caught — a plain
 * toBeHidden() assertion would miss it.
 *
 * De-flake: the fully/partially-prefetched distinction is synchronized on the
 * prefetch network (request start for "partial", body fully received for
 * "fully-prefetched") instead of fixed sleeps, so the click reliably lands at
 * the intended point in the stream.
 *
 * Routes (e2e/test-app):
 *  - /slow-streaming  : loading() DSL + 1s loader (skeleton: slow-streaming-loading)
 *  - /suspense-stream : raw <Suspense> + 2s async SERVER child (fallback: suspense-stream-fallback)
 *  - /cs-layout/{from,to} : a SHARED layout with a loading() boundary; /to renders a
 *                           CLIENT component that suspends on MOUNT with no <Suspense>
 *                           of its own (layout fallback: cs-layout-fallback). The
 *                           persistent layout boundary is what distinguishes a normal
 *                           commit (reveal fallback) from the old startTransition
 *                           commit (hold the previous child's content).
 * Prefetch links live on "/" (slow-streaming-prefetch-link, suspense-stream-prefetch-link)
 * and inside the cs-layout (cs-from-link, cs-to-link with prefetch=hover).
 */

// Match a prefetch fetch for a given target path: a low-priority GET partial
// request the Link fires on hover. Keyed on the target path + _rsc_partial so it
// is not confused with the eventual navigation fetch (warm nav reuses the cache
// and issues no fetch; a cold/partial nav would, but we sync BEFORE clicking).
function isPrefetchFor(url: string, targetPath: string): boolean {
  return url.includes(targetPath) && url.includes("_rsc_partial=true");
}

// Exact-pathname variant for request COUNTING. The substring matcher above is
// fine for waiting on a known request, but a zero-refetch assertion must not
// pick up partials for sibling routes whose path merely CONTAINS the target
// (e.g. /slow-streaming-skip-ssr viewport-prefetched by production's
// defaultPrefetch when navigating back to "/").
function isPrefetchExactly(url: string, targetPath: string): boolean {
  try {
    const u = new URL(url);
    return u.pathname === targetPath && u.searchParams.has("_rsc_partial");
  } catch {
    return false;
  }
}

// Record whether a fallback/skeleton element is EVER inserted into the DOM during
// the wrapped action (catches transient single-frame flashes).
async function watchFlash(page: Page, fallbackTestId: string) {
  await page.evaluate((id) => {
    const w = window as unknown as {
      __flash?: boolean;
      __obs?: MutationObserver;
    };
    w.__flash = document.querySelector(`[data-testid="${id}"]`) != null;
    const hit = (n: Node) =>
      n.nodeType === 1 &&
      ((n as Element).matches?.(`[data-testid="${id}"]`) ||
        (n as Element).querySelector?.(`[data-testid="${id}"]`) != null);
    w.__obs = new MutationObserver((records) => {
      for (const r of records)
        for (const n of Array.from(r.addedNodes)) if (hit(n)) w.__flash = true;
    });
    w.__obs.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  }, fallbackTestId);
}
async function readFlash(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const w = window as unknown as {
      __flash?: boolean;
      __obs?: MutationObserver;
    };
    w.__obs?.disconnect();
    return w.__flash === true;
  });
}

function prefetchTransitionTests(mode: "dev" | "build") {
  const label = mode === "build" ? "production" : mode;

  test.describe(`prefetch-transition (${label})`, () => {
    const f = useFixture({ root: "./e2e/test-app", mode });
    test.setTimeout(60000);

    test("loading() cold nav streams the skeleton", async ({ page }) => {
      using _ = expectNoPageError(page);
      await page.goto(f.url("/"));
      await waitForHydration(page);

      await watchFlash(page, "slow-streaming-loading");
      await testId(page, "slow-streaming-link").click();
      await expect(testId(page, "slow-streaming-message")).toContainText(
        "Slow data loaded",
        { timeout: 8000 },
      );
      expect(await readFlash(page), "cold nav must stream the skeleton").toBe(
        true,
      );
    });

    test("loading() partially-prefetched (in-flight) still streams the skeleton", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);
      await page.goto(f.url("/"));
      await waitForHydration(page);

      // Synchronize on the prefetch REQUEST starting (event-driven), then click
      // immediately — well before the 1s loader resolves — so the entry is still
      // streaming (not fully prefetched). No fixed sleep gates this distinction.
      const prefetchStarted = page.waitForRequest(
        (req) =>
          req.method() === "GET" && isPrefetchFor(req.url(), "/slow-streaming"),
      );
      await page.hover('[data-testid="slow-streaming-prefetch-link"]');
      await prefetchStarted;

      await watchFlash(page, "slow-streaming-loading");
      await testId(page, "slow-streaming-prefetch-link").click();
      await expect(testId(page, "slow-streaming-message")).toContainText(
        "Slow data loaded",
        { timeout: 8000 },
      );
      expect(
        await readFlash(page),
        "in-flight prefetch must stream the skeleton (not auto-transition)",
      ).toBe(true);
    });

    test("loading() fully-prefetched commits without a skeleton flash", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);
      await page.goto(f.url("/"));
      await waitForHydration(page);

      // Synchronize on the prefetch RESPONSE body being fully received
      // (response.finished()), i.e. the stream drained -> entry.complete -> the
      // fully-prefetched fast path. Event-driven, no fixed sleep.
      const prefetchResponse = page.waitForResponse((resp) =>
        isPrefetchFor(resp.url(), "/slow-streaming"),
      );
      await page.hover('[data-testid="slow-streaming-prefetch-link"]');
      const resp = await prefetchResponse;
      await resp.finished();

      await watchFlash(page, "slow-streaming-loading");
      await testId(page, "slow-streaming-prefetch-link").click();
      await expect(testId(page, "slow-streaming-message")).toContainText(
        "Slow data loaded",
        { timeout: 8000 },
      );
      expect(
        await readFlash(page),
        "fully-prefetched nav must NOT flash the skeleton",
      ).toBe(false);
    });

    test("raw <Suspense> fully-prefetched resolves directly (no fallback flash)", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);
      await page.goto(f.url("/"));
      await waitForHydration(page);

      const prefetchResponse = page.waitForResponse((resp) =>
        isPrefetchFor(resp.url(), "/suspense-stream"),
      );
      await page.hover('[data-testid="suspense-stream-prefetch-link"]');
      const resp = await prefetchResponse;
      await resp.finished();

      await watchFlash(page, "suspense-stream-fallback");
      await testId(page, "suspense-stream-prefetch-link").click();
      await expect(testId(page, "suspense-stream-content")).toHaveText(
        "resolved",
        { timeout: 8000 },
      );
      expect(
        await readFlash(page),
        "fully-prefetched raw <Suspense> must NOT flash the fallback",
      ).toBe(false);
    });

    test("retains a fully-prefetched sibling after navigating to another prefetched route", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);
      await page.goto(f.url("/"));
      await waitForHydration(page);

      const firstResponsePromise = page.waitForResponse((resp) =>
        isPrefetchFor(resp.url(), "/slow-streaming?prefetch-sequence=first"),
      );
      await page.hover('[data-testid="nav-prefetch-sequence-first"]');
      const firstResponse = await firstResponsePromise;

      const secondResponsePromise = page.waitForResponse((resp) =>
        isPrefetchFor(resp.url(), "/suspense-stream?prefetch-sequence=second"),
      );
      await page.hover('[data-testid="nav-prefetch-sequence-second"]');
      const secondResponse = await secondResponsePromise;
      await Promise.all([firstResponse.finished(), secondResponse.finished()]);

      await testId(page, "nav-prefetch-sequence-first").click();
      await expect(testId(page, "slow-streaming-message")).toContainText(
        "Slow data loaded",
        { timeout: 8000 },
      );

      await watchFlash(page, "suspense-stream-fallback");
      await testId(page, "nav-prefetch-sequence-second").click();
      await expect(testId(page, "suspense-stream-content")).toHaveText(
        "resolved",
        { timeout: 8000 },
      );
      expect(
        await readFlash(page),
        "a sibling prefetched from the original page must stay warm after the first navigation",
      ).toBe(false);
    });

    test("a consumed prefetch re-arms: revisiting the route is warm with no refetch", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);
      await page.goto(f.url("/"));
      await waitForHydration(page);

      // Prefetch fully (body received -> entry.complete + respawn armed).
      const prefetchResponse = page.waitForResponse((resp) =>
        isPrefetchFor(resp.url(), "/slow-streaming"),
      );
      await page.hover('[data-testid="slow-streaming-prefetch-link"]');
      const resp = await prefetchResponse;
      await resp.finished();

      // Every /slow-streaming partial request from here on is a re-fetch the
      // re-armed cache should have made unnecessary.
      const refetches: string[] = [];
      page.on("request", (req) => {
        if (
          req.method() === "GET" &&
          isPrefetchExactly(req.url(), "/slow-streaming")
        ) {
          refetches.push(req.url());
        }
      });

      // First navigation adopts the entry — and re-arms the slot from the
      // buffered bytes instead of spending it.
      await testId(page, "slow-streaming-prefetch-link").click();
      await expect(testId(page, "slow-streaming-message")).toContainText(
        "Slow data loaded",
        { timeout: 8000 },
      );

      // Leave via history (popstate restores from the FE history cache and
      // does not touch the prefetch map), then forward-click the same route
      // again. Pre-respawn this second click found an empty slot: the click's
      // own hover fired a fresh prefetch, the 1s loader streamed the skeleton,
      // and a second network request was issued.
      await page.goBack();
      await expect(testId(page, "slow-streaming-prefetch-link")).toBeVisible();

      await watchFlash(page, "slow-streaming-loading");
      await testId(page, "slow-streaming-prefetch-link").click();
      await expect(testId(page, "slow-streaming-message")).toContainText(
        "Slow data loaded",
        { timeout: 8000 },
      );
      expect(
        await readFlash(page),
        "the re-armed entry must serve the revisit without a skeleton flash",
      ).toBe(false);
      expect(
        refetches,
        "one prefetch serves both navigations: no request after the original",
      ).toEqual([]);
    });

    test("a mid-stream adoption refills the slot: the revisit is warm with no refetch", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);
      await page.goto(f.url("/"));
      await waitForHydration(page);

      // Synchronize on the prefetch REQUEST starting, then click immediately —
      // well before the 1s loader resolves — so the adoption happens while the
      // stream is still open (respawn cannot be armed yet at click time).
      const prefetchStarted = page.waitForRequest(
        (req) =>
          req.method() === "GET" && isPrefetchFor(req.url(), "/slow-streaming"),
      );
      await page.hover('[data-testid="slow-streaming-prefetch-link"]');
      await prefetchStarted;

      // Every /slow-streaming partial request from here on is a re-fetch the
      // refilled slot should have made unnecessary.
      const refetches: string[] = [];
      page.on("request", (req) => {
        if (
          req.method() === "GET" &&
          isPrefetchExactly(req.url(), "/slow-streaming")
        ) {
          refetches.push(req.url());
        }
      });

      await testId(page, "slow-streaming-prefetch-link").click();
      await expect(testId(page, "slow-streaming-message")).toContainText(
        "Slow data loaded",
        { timeout: 8000 },
      );

      // The adopted stream finished while rendering the first visit; its clean
      // EOF must refill the slot with a respawned sibling. Revisit forward:
      // warm, no skeleton, no network.
      await page.goBack();
      await expect(testId(page, "slow-streaming-prefetch-link")).toBeVisible();

      await watchFlash(page, "slow-streaming-loading");
      await testId(page, "slow-streaming-prefetch-link").click();
      await expect(testId(page, "slow-streaming-message")).toContainText(
        "Slow data loaded",
        { timeout: 8000 },
      );
      expect(
        await readFlash(page),
        "the refilled slot must serve the revisit without a skeleton flash",
      ).toBe(false);
      expect(
        refetches,
        "the mid-stream adoption's request serves both navigations",
      ).toEqual([]);
    });

    test("fully-prefetched nav whose CLIENT component suspends on mount HOLDS the old page (no fallback flash)", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);
      // Land on /cs-layout/from: a child under a SHARED layout that has a
      // loading() boundary around its <Outlet/>.
      await page.goto(f.url("/cs-layout/from"));
      await waitForHydration(page);
      await expect(testId(page, "cs-from-content")).toBeVisible();

      // Prefetch the sibling /cs-layout/to fully (response body received). Its
      // server render is immediate, so the entry is `complete` (fullyPrefetched).
      const prefetchResponse = page.waitForResponse((resp) =>
        isPrefetchFor(resp.url(), "/cs-layout/to"),
      );
      await page.hover('[data-testid="cs-to-link"]');
      const resp = await prefetchResponse;
      await resp.finished();

      // Navigate from -> to. The SHARED layout segment persists, so its
      // loading() boundary is already revealed — the startTransition commit
      // must HOLD /from's outlet content across the client mount-suspense
      // instead of swapping in the layout fallback.
      await watchFlash(page, "cs-layout-fallback");
      await testId(page, "cs-to-link").click();

      // The old content stays visible while the client promise resolves…
      await expect(testId(page, "cs-from-content")).toBeVisible();
      // …then the new content lands, and the layout fallback was NEVER
      // inserted (MutationObserver catches even a single-frame flash).
      await expect(testId(page, "client-suspense-content")).toHaveText(
        "client-mounted",
        { timeout: 8000 },
      );
      expect(await readFlash(page)).toBe(false);
    });

    test("fully-prefetched nav whose CLIENT component has its OWN boundary reveals the LOCAL fallback (escape hatch from the hold)", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);
      await page.goto(f.url("/cs-layout/from"));
      await waitForHydration(page);
      await expect(testId(page, "cs-from-content")).toBeVisible();

      const prefetchResponse = page.waitForResponse((resp) =>
        isPrefetchFor(resp.url(), "/cs-layout/to-bounded"),
      );
      await page.hover('[data-testid="cs-to-bounded-link"]');
      const resp = await prefetchResponse;
      await resp.finished();

      // Same warm startTransition commit as above, but the suspending client
      // component ships its OWN <Suspense>. That boundary is NEWLY MOUNTED by
      // this nav, and a transition only waits to avoid hiding already-revealed
      // content — so React commits immediately, revealing the LOCAL fallback
      // in place while the old /from content unmounts. The persistent layout
      // fallback must never be inserted.
      await watchFlash(page, "cs-layout-fallback");
      await testId(page, "cs-to-bounded-link").click();

      await expect(testId(page, "cs-local-fallback")).toBeVisible({
        timeout: 8000,
      });
      await expect(testId(page, "cs-from-content")).toBeHidden();
      await expect(testId(page, "client-suspense-bounded-content")).toHaveText(
        "client-mounted-bounded",
        { timeout: 8000 },
      );
      expect(await readFlash(page)).toBe(false);
    });

    test("fully-prefetched nav with a deferred Meta does not flash, and the title still lands", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);
      await page.goto(f.url("/"));
      await waitForHydration(page);

      // /suspense-stream-meta has a raw <Suspense> AND a deferred Meta title.
      // Drain the prefetch fully (response body received), then navigate: the
      // fully-prefetched commit must not flash the fallback, and the deferred
      // title must still be applied. This pins that the deferred-handle branch
      // composes with the commit — it neither holds the commit (which would let
      // the fallback flash on a revert) nor drops the title.
      const prefetchResponse = page.waitForResponse((resp) =>
        isPrefetchFor(resp.url(), "/suspense-stream-meta"),
      );
      await page.hover('[data-testid="suspense-stream-meta-prefetch-link"]');
      const resp = await prefetchResponse;
      await resp.finished();

      await watchFlash(page, "suspense-stream-fallback");
      await testId(page, "suspense-stream-meta-prefetch-link").click();
      await expect(testId(page, "suspense-stream-content")).toHaveText(
        "resolved",
        { timeout: 8000 },
      );
      expect(
        await readFlash(page),
        "fully-prefetched deferred-Meta nav must NOT flash the fallback",
      ).toBe(false);
      await expect
        .poll(() => page.title(), { timeout: 8000 })
        .toContain("Streamed Title");
    });

    test("FE history-cache hit (popstate) shows no loading() skeleton", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);
      await page.goto(f.url("/"));
      await waitForHydration(page);

      // First visit caches the route's segments at this history entry.
      await testId(page, "slow-streaming-link").click();
      await expect(testId(page, "slow-streaming-message")).toContainText(
        "Slow data loaded",
        { timeout: 8000 },
      );
      await page.goBack();
      await expect(testId(page, "slow-streaming-link")).toBeVisible();

      // Forward popstate is served from the FE history cache (resolved before
      // commit), so no skeleton appears.
      await watchFlash(page, "slow-streaming-loading");
      await page.goForward();
      await expect(testId(page, "slow-streaming-message")).toContainText(
        "Slow data loaded",
        { timeout: 8000 },
      );
      expect(
        await readFlash(page),
        "FE history-cache hit must not flash the skeleton",
      ).toBe(false);
    });
  });
}

prefetchTransitionTests("dev");
prefetchTransitionTests("build");
