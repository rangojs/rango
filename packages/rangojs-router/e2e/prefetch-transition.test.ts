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
 *  - cold nav                         -> stream fallback/skeleton
 *  - partially-prefetched (in-flight) -> stream fallback/skeleton (NOT held)
 *  - fully-prefetched (stream drained)-> startTransition: resolve directly, no flash
 *  - FE history-cache hit (popstate)  -> no flash (resolved-before-commit)
 *
 * The fully-prefetched row is the behavior added by the `fullyPrefetched` flag
 * (navigation-client -> partial-update). It covers BOTH a router loading()
 * skeleton and a consumer's raw <Suspense> fallback. The partial/cold rows guard
 * against over-transitioning (they must keep streaming).
 *
 * Flash detection uses a MutationObserver on addedNodes so even a single-frame
 * fallback that is added then immediately removed is caught — a plain
 * toBeHidden() assertion would miss it.
 *
 * Routes (e2e/test-app):
 *  - /slow-streaming : loading() DSL + 1s loader (skeleton: slow-streaming-loading)
 *  - /suspense-stream: raw <Suspense> + 2s async child (fallback: suspense-stream-fallback)
 * Prefetch links live on "/" (slow-streaming-prefetch-link, suspense-stream-prefetch-link).
 */

const LOADER_DELAY = 1000;
const SUSPENSE_DELAY = 2000;

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

      // Hover starts the prefetch; click well before the 1s loader resolves so the
      // entry is still streaming (not fully prefetched).
      await page.hover('[data-testid="slow-streaming-prefetch-link"]');
      await page.waitForTimeout(150);
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

    test("loading() fully-prefetched commits in a transition (no skeleton flash)", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);
      await page.goto(f.url("/"));
      await waitForHydration(page);

      // Hover then wait past the loader delay so the prefetch stream fully drains.
      await page.hover('[data-testid="slow-streaming-prefetch-link"]');
      await page.waitForTimeout(LOADER_DELAY + 800);
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

      await page.hover('[data-testid="suspense-stream-prefetch-link"]');
      await page.waitForTimeout(SUSPENSE_DELAY + 800);
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

    test("fully-prefetched nav with a deferred Meta does not flash, and the title still lands", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);
      await page.goto(f.url("/"));
      await waitForHydration(page);

      // /suspense-stream-meta has a raw <Suspense> AND a deferred Meta title.
      // Drain the prefetch fully (past the 2s child + meta), then navigate: the
      // fully-prefetched commit must not flash the fallback, and the deferred
      // title must still be applied. This pins that the deferred-handle branch
      // composes with the transition commit — it neither holds the commit (which
      // would let the fallback flash on a revert) nor drops the title.
      await page.hover('[data-testid="suspense-stream-meta-prefetch-link"]');
      await page.waitForTimeout(SUSPENSE_DELAY + 800);
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
