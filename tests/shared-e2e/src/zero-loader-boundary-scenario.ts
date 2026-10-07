import { expect, test, type Page } from "@playwright/test";

/**
 * A layout with loading() and no loaders, children /zlb/a and /zlb/b, a hub
 * at /zlb. Entering /zlb/a by a fully prefetched click and then clicking to
 * the un-prefetched /zlb/b must not show the layout's fallback (a boundary
 * with no loaders was handed a promise React had not read). Both apps mount
 * the same fixture and call this from a dev and a (production) describe.
 */

export interface ZeroLoaderBoundaryScenarioOptions {
  url: (pathname: string) => string;
  waitForHydration: (page: Page) => Promise<void>;
}

async function watchBoundary(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as {
      __zlb: { fallback: boolean; detached: boolean; obs: MutationObserver };
    };
    const state = {
      fallback: document.querySelector('[data-testid="zlb-fallback"]') != null,
      detached: false,
    };
    const has = (n: Node, id: string): boolean =>
      n.nodeType === 1 &&
      ((n as Element).matches?.(`[data-testid="${id}"]`) ||
        (n as Element).querySelector?.(`[data-testid="${id}"]`) != null);
    const obs = new MutationObserver((records) => {
      for (const r of records) {
        for (const n of Array.from(r.addedNodes)) {
          if (has(n, "zlb-fallback")) state.fallback = true;
        }
        for (const n of Array.from(r.removedNodes)) {
          if (has(n, "zlb-layout")) state.detached = true;
        }
      }
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
    w.__zlb = Object.assign(state, { obs });
  });
}

async function readBoundary(
  page: Page,
): Promise<{ fallback: boolean; detached: boolean }> {
  return page.evaluate(() => {
    const w = window as unknown as {
      __zlb: { fallback: boolean; detached: boolean; obs: MutationObserver };
    };
    w.__zlb.obs.disconnect();
    return { fallback: w.__zlb.fallback, detached: w.__zlb.detached };
  });
}

function trackRequestsFor(page: Page, pathname: string): string[] {
  const seen: string[] = [];
  page.on("request", (req) => {
    if (new URL(req.url()).pathname === pathname) seen.push(req.url());
  });
  return seen;
}

async function clickThroughToB(page: Page, bRequests: string[]) {
  expect(bRequests, "/zlb/b must not have been requested yet").toEqual([]);
  await watchBoundary(page);
  await page.locator('[data-testid="zlb-to-b"]').click();
  await expect(page.locator('[data-testid="zlb-b"]')).toBeVisible();
  const seen = await readBoundary(page);
  expect(seen.fallback, "the layout's loading() fallback must not appear").toBe(
    false,
  );
  expect(seen.detached, "the layout on screen must not be detached").toBe(
    false,
  );
}

export function runZeroLoaderBoundaryTests(
  options: ZeroLoaderBoundaryScenarioOptions,
): void {
  const { url, waitForHydration } = options;

  test("a plain click to an un-prefetched sibling after a fully prefetched click shows no layout fallback", async ({
    page,
  }) => {
    const bRequests = trackRequestsFor(page, "/zlb/b");
    await page.goto(url("/zlb"));
    await waitForHydration(page);

    const prefetched = page.waitForResponse((resp) => {
      const u = new URL(resp.url());
      return u.pathname === "/zlb/a" && u.searchParams.has("_rsc_partial");
    });
    await page.hover('[data-testid="zlb-hub-prefetched"]');
    await (await prefetched).finished();

    await page.locator('[data-testid="zlb-hub-prefetched"]').click();
    await expect(page.locator('[data-testid="zlb-a"]')).toBeVisible();

    await clickThroughToB(page, bRequests);
  });

  test("control: entering by a plain click shows no layout fallback on the next click", async ({
    page,
  }) => {
    const bRequests = trackRequestsFor(page, "/zlb/b");
    await page.goto(url("/zlb"));
    await waitForHydration(page);

    await page.locator('[data-testid="zlb-hub-plain"]').click();
    await expect(page.locator('[data-testid="zlb-a"]')).toBeVisible();

    await clickThroughToB(page, bRequests);
  });

  test("control: loading the document on the layout shows no fallback on the next click", async ({
    page,
  }) => {
    const bRequests = trackRequestsFor(page, "/zlb/b");
    await page.goto(url("/zlb/a"));
    await waitForHydration(page);
    await expect(page.locator('[data-testid="zlb-a"]')).toBeVisible();

    await clickThroughToB(page, bRequests);
  });
}
