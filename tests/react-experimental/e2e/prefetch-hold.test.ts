import test, { expect, type Page } from "@playwright/test";
import { useFixture, type Fixture } from "./fixture";
import {
  expectNoPageError,
  installVtRecorder,
  testId,
  vtCount,
  vtTypes,
  waitForHydration,
} from "./helper";

/**
 * Fully-prefetched commit mode on EXPERIMENTAL React (mirrors the
 * prefetch-transition suites in the router e2e app and cloudflare-basic).
 *
 * The /xcs routes have NO transition(), so a warm (fully-prefetched) nav takes
 * the automatic bare-startTransition branch. Contract pinned:
 *
 *  - bare use() (no own boundary) -> the already-revealed layout loading()
 *    boundary HOLDS the old page until the client promise resolves; the layout
 *    fallback is never inserted.
 *  - own <Suspense> -> the boundary is newly mounted by the nav, so its LOCAL
 *    fallback is revealed immediately even inside the transition.
 *  - neither nav fires document.startViewTransition — the bare content-hold
 *    involves no <ViewTransition> boundary, and experimental React is where a
 *    stray VT would actually run (installVtRecorder spies on it).
 */

function isPrefetchFor(url: string, targetPath: string): boolean {
  return url.includes(targetPath) && url.includes("_rsc_partial=true");
}

// Record whether a fallback element is EVER inserted during the wrapped action
// (catches transient single-frame flashes a toBeHidden() would miss).
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

function defineTests(f: Fixture) {
  test("fully-prefetched nav whose CLIENT component suspends on mount HOLDS the old page (no fallback flash)", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await page.goto(f.url("/xcs/from"));
    await waitForHydration(page);
    await expect(testId(page, "xcs-from-content")).toBeVisible();
    await installVtRecorder(page);

    const prefetchResponse = page.waitForResponse((resp) =>
      isPrefetchFor(resp.url(), "/xcs/to"),
    );
    await page.hover('[data-testid="xcs-to-link"]');
    const resp = await prefetchResponse;
    await resp.finished();

    await watchFlash(page, "xcs-layout-fallback");
    await testId(page, "xcs-to-link").click();

    // Old content held while the client promise resolves; the layout fallback
    // is never inserted; no view transition fires (no boundary involved).
    await expect(testId(page, "xcs-from-content")).toBeVisible();
    await expect(testId(page, "xcs-content")).toHaveText("client-mounted", {
      timeout: 8000,
    });
    expect(await readFlash(page)).toBe(false);
    expect(await vtCount(page)).toBe(0);
  });

  test("fully-prefetched nav whose CLIENT component has its OWN boundary reveals the LOCAL fallback (escape hatch from the hold)", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await page.goto(f.url("/xcs/from"));
    await waitForHydration(page);
    await expect(testId(page, "xcs-from-content")).toBeVisible();
    await installVtRecorder(page);

    const prefetchResponse = page.waitForResponse((resp) =>
      isPrefetchFor(resp.url(), "/xcs/to-bounded"),
    );
    await page.hover('[data-testid="xcs-to-bounded-link"]');
    const resp = await prefetchResponse;
    await resp.finished();

    // The component-own boundary is newly mounted by this nav: even inside the
    // transition its LOCAL fallback is revealed immediately while the old page
    // unmounts; the layout fallback is never inserted.
    await watchFlash(page, "xcs-layout-fallback");
    await testId(page, "xcs-to-bounded-link").click();

    await expect(testId(page, "xcs-local-fallback")).toBeVisible({
      timeout: 8000,
    });
    await expect(testId(page, "xcs-from-content")).toBeHidden();
    await expect(testId(page, "xcs-bounded-content")).toHaveText(
      "client-mounted-bounded",
      { timeout: 8000 },
    );
    expect(await readFlash(page)).toBe(false);
    expect(await vtCount(page)).toBe(0);
  });

  test("fully-prefetched nav on a transition() route commits via the FULL transition branch (navigation type fires)", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await page.goto(f.url("/xcs-tx/from"));
    await waitForHydration(page);
    await expect(testId(page, "xcs-tx-from-content")).toBeVisible();
    await installVtRecorder(page);

    const prefetchResponse = page.waitForResponse((resp) =>
      isPrefetchFor(resp.url(), "/xcs-tx/to"),
    );
    await page.hover('[data-testid="xcs-tx-to-link"]');
    const resp = await prefetchResponse;
    await resp.finished();

    await testId(page, "xcs-tx-to-link").click();
    await expect(testId(page, "xcs-tx-to-content")).toBeVisible({
      timeout: 8000,
    });

    // Branch-order pin: hasTransition must own a WARM commit on a transition()
    // route — the VT fires WITH the "navigation" type (addTransitionType). If
    // the bare fullyPrefetched branch ever wins instead, the VT types come
    // through empty and this breaks.
    expect(await vtCount(page)).toBeGreaterThanOrEqual(1);
    expect((await vtTypes(page)).some((t) => t.includes("navigation"))).toBe(
      true,
    );
  });
}

test.describe("prefetch-hold (dev)", () => {
  const f = useFixture({ root: ".", mode: "dev" });
  defineTests(f);
});

test.describe("prefetch-hold (production)", () => {
  const f = useFixture({ root: ".", mode: "build" });
  defineTests(f);
});
