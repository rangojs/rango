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
 *  - commit inside a bare startTransition, so a CLIENT component that suspends
 *    during its first render under a persistent (already-revealed) layout
 *    boundary HOLDS the previous page until it resolves — no fallback flash
 *    anywhere (#622 -> #624 -> reinstated transition).
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

    test("retains a fully-prefetched sibling after navigating to another prefetched route", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);
      await page.goto(f.url("/"));
      await waitForHydration(page);

      const firstResponsePromise = page.waitForResponse((resp) =>
        isPrefetchFor(resp.url(), "/pt-slow?prefetch-sequence=first"),
      );
      await page.hover('[data-testid="nav-prefetch-sequence-first"]');
      const firstResponse = await firstResponsePromise;

      const secondResponsePromise = page.waitForResponse((resp) =>
        isPrefetchFor(resp.url(), "/stream-test/1?prefetch-sequence=second"),
      );
      await page.hover('[data-testid="nav-prefetch-sequence-second"]');
      const secondResponse = await secondResponsePromise;
      await Promise.all([firstResponse.finished(), secondResponse.finished()]);

      await testId(page, "nav-prefetch-sequence-first").click();
      await expect(testId(page, "pt-slow-message")).toContainText(
        "pt-slow loaded",
        { timeout: 8000 },
      );

      await watchFlash(page, "stream-test-fallback");
      await testId(page, "nav-prefetch-sequence-second").click();
      await expect(testId(page, "stream-test-content")).toHaveText(
        "Test: resolved 1",
        { timeout: 8000 },
      );
      expect(
        await readFlash(page),
        "a sibling prefetched from the original page must stay warm after the first navigation",
      ).toBe(false);
    });

    test("fully-prefetched nav whose CLIENT component suspends on mount HOLDS the old page (no fallback flash)", async ({
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

      // The startTransition commit must HOLD the old /from content across the
      // client mount-suspense; the persistent layout boundary's fallback must
      // never be inserted.
      await watchFlash(page, "pt-layout-loading");
      await testId(page, "pt-to-link").click();

      await expect(testId(page, "pt-from-content")).toBeVisible();
      await expect(testId(page, "cf-cs-content")).toHaveText("client-mounted", {
        timeout: 8000,
      });
      expect(await readFlash(page)).toBe(false);
    });

    test("fully-prefetched nav whose CLIENT component has its OWN boundary reveals the LOCAL fallback (escape hatch from the hold)", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);
      await page.goto(f.url("/pt-layout/from"));
      await waitForHydration(page);
      await expect(testId(page, "pt-from-content")).toBeVisible();

      const prefetchResponse = page.waitForResponse((resp) =>
        isPrefetchFor(resp.url(), "/pt-layout/to-bounded"),
      );
      await page.hover('[data-testid="pt-to-bounded-link"]');
      const resp = await prefetchResponse;
      await resp.finished();

      // Same warm startTransition commit as above, but the component ships its
      // OWN <Suspense>. Newly mounted by this nav, so React reveals the LOCAL
      // fallback immediately even inside the transition; the persistent layout
      // fallback must never be inserted.
      await watchFlash(page, "pt-layout-loading");
      await testId(page, "pt-to-bounded-link").click();

      await expect(testId(page, "pt-local-fallback")).toBeVisible({
        timeout: 8000,
      });
      await expect(testId(page, "pt-from-content")).toBeHidden();
      await expect(testId(page, "cf-cs-bounded-content")).toHaveText(
        "client-mounted-bounded",
        { timeout: 8000 },
      );
      expect(await readFlash(page)).toBe(false);
    });
  });
}

prefetchTransitionTests("dev");
prefetchTransitionTests("build");
