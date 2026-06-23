import { expect, test, type Page } from "@playwright/test";
import { useFixture } from "./fixture";
import { expectNoPageError, testId, waitForHydration } from "./helper";

/**
 * #622 follow-up prefetch-transition coverage for the cloudflare-basic app
 * (mirrors packages/rangojs-router/e2e/prefetch-transition.test.ts).
 *
 * A fully-prefetched navigation must:
 *  - commit the already-resolved ROUTER data with NO loading() flash (the
 *    forceAwait content unwrap), and
 *  - NOT hold the previous page when a CLIENT component suspends on mount under a
 *    persistent layout boundary — the normal commit reveals that boundary's
 *    loading() fallback instead.
 * A still-streaming (partial) prefetch must keep streaming its fallback.
 *
 * Routes (cloudflare-basic):
 *  - /pt-slow             : loading() route + slow loader (skeleton: pt-slow-loading)
 *  - /pt-layout/{from,to} : shared layout w/ loading() boundary; /to's CLIENT
 *                           component suspends on mount (layout fallback:
 *                           pt-layout-loading; resolved content: cf-cs-content)
 *
 * Synchronization is event-driven on the prefetch network (no fixed sleeps).
 */

function isPrefetchFor(url: string, targetPath: string): boolean {
  return url.includes(targetPath) && url.includes("_rsc_partial=true");
}

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
    const f = useFixture({ root: ".", mode });
    test.setTimeout(60000);

    test("loading() cold nav streams the skeleton", async ({ page }) => {
      using _ = expectNoPageError(page);
      await page.goto(f.url("/"));
      await waitForHydration(page);

      // Use the plain (no-prefetch) link so the data is cold at click time.
      await watchFlash(page, "pt-slow-loading");
      await testId(page, "pt-slow-cold-link").click();
      await expect(testId(page, "pt-slow-message")).toContainText(
        "pt-slow loaded",
        { timeout: 8000 },
      );
      expect(await readFlash(page), "cold nav must stream the skeleton").toBe(
        true,
      );
    });

    test("loading() fully-prefetched commits without a skeleton flash", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);
      await page.goto(f.url("/"));
      await waitForHydration(page);

      const prefetchResponse = page.waitForResponse((resp) =>
        isPrefetchFor(resp.url(), "/pt-slow"),
      );
      await page.hover('[data-testid="pt-slow-prefetch-link"]');
      const resp = await prefetchResponse;
      await resp.finished();

      await watchFlash(page, "pt-slow-loading");
      await testId(page, "pt-slow-prefetch-link").click();
      await expect(testId(page, "pt-slow-message")).toContainText(
        "pt-slow loaded",
        { timeout: 8000 },
      );
      expect(
        await readFlash(page),
        "fully-prefetched nav must NOT flash the skeleton",
      ).toBe(false);
    });

    test("fully-prefetched nav whose CLIENT component suspends on mount reveals the layout fallback (does NOT hold the old page)", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);
      await page.goto(f.url("/pt-layout/from"));
      await waitForHydration(page);
      await expect(testId(page, "pt-from-content")).toBeVisible();

      const prefetchResponse = page.waitForResponse((resp) =>
        isPrefetchFor(resp.url(), "/pt-layout/to"),
      );
      await page.hover('[data-testid="pt-to-link"]');
      const resp = await prefetchResponse;
      await resp.finished();

      await testId(page, "pt-to-link").click();

      // The persistent layout boundary must reveal its fallback (the regression:
      // the old /from content would otherwise be held). Then the client resolves.
      await expect(testId(page, "pt-layout-loading")).toBeVisible({
        timeout: 8000,
      });
      await expect(testId(page, "cf-cs-content")).toHaveText("client-mounted", {
        timeout: 8000,
      });
    });
  });
}

prefetchTransitionTests("dev");
prefetchTransitionTests("build");
