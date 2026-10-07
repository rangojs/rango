import { expect, test, type Page } from "@playwright/test";

/**
 * Held-boundary scenarios. Entering /<s>/a by a fully prefetched click and
 * then clicking to the un-prefetched /<s>/b must not replace a boundary
 * already on screen with its loading() fallback (the router handed it a
 * promise React had not read). Fixture: zero-loader-boundary.tsx in each
 * app; both apps call this from a dev and a (production) describe.
 */

export interface ZeroLoaderBoundaryScenarioOptions {
  url: (pathname: string) => string;
  waitForHydration: (page: Page) => Promise<void>;
}

interface Scenario {
  name: string;
  s: string;
  // Test ids that must stay attached and visible across the click.
  held: string[];
  // false: the new route may show its own fallback (route-sibling control).
  noFallback: boolean;
}

const SCENARIOS: Scenario[] = [
  {
    name: "layout with loading() and no loaders",
    s: "zlb",
    held: ["zlb-layout"],
    noFallback: true,
  },
  {
    name: "layout with loading() and a loader",
    s: "zlbl",
    held: ["zlbl-layout", "zlbl-value"],
    noFallback: true,
  },
  {
    name: "parallel slot with a loader and loading()",
    s: "zlbs",
    held: ["zlbs-slot", "zlbs-slot-value"],
    noFallback: true,
  },
  {
    name: "route siblings with their own loader and loading()",
    s: "zlbr",
    held: ["zlbr-layout"],
    noFallback: false,
  },
];

type Probe = {
  fallback: boolean;
  detached: boolean;
  obs: MutationObserver;
};

async function watch(page: Page, s: string, held: string[]): Promise<void> {
  await page.evaluate(
    ({ s, held }) => {
      const w = window as unknown as { __zlb: Probe };
      const state = {
        fallback:
          document.querySelector(`[data-testid="${s}-fallback"]`) != null,
        detached: false,
      };
      const has = (n: Node, id: string): boolean =>
        n.nodeType === 1 &&
        ((n as Element).matches?.(`[data-testid="${id}"]`) ||
          (n as Element).querySelector?.(`[data-testid="${id}"]`) != null);
      const obs = new MutationObserver((records) => {
        for (const r of records) {
          for (const n of Array.from(r.addedNodes)) {
            if (has(n, `${s}-fallback`)) state.fallback = true;
          }
          for (const n of Array.from(r.removedNodes)) {
            if (held.some((id) => has(n, id))) state.detached = true;
          }
        }
      });
      obs.observe(document.documentElement, { childList: true, subtree: true });
      w.__zlb = Object.assign(state, { obs });
    },
    { s, held },
  );
}

async function read(
  page: Page,
): Promise<{ fallback: boolean; detached: boolean }> {
  return page.evaluate(() => {
    const w = window as unknown as { __zlb: Probe };
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

async function expectHeldVisible(page: Page, held: string[]): Promise<void> {
  for (const id of held) {
    await expect(page.locator(`[data-testid="${id}"]`)).toBeVisible();
  }
}

async function clickThroughToB(
  page: Page,
  sc: Scenario,
  bRequests: string[],
): Promise<void> {
  await expect(page.locator(`[data-testid="${sc.s}-a"]`)).toBeVisible();
  await expectHeldVisible(page, sc.held);
  expect(bRequests, `/${sc.s}/b must not have been requested yet`).toEqual([]);

  await watch(page, sc.s, sc.held);
  await page.locator(`[data-testid="${sc.s}-to-b"]`).click();
  await expect(page.locator(`[data-testid="${sc.s}-b"]`)).toBeVisible();
  // A held boundary hidden behind its fallback is not visible until the
  // fallback goes, so this also waits out a flash before the probe is read.
  await expectHeldVisible(page, sc.held);
  const seen = await read(page);

  if (sc.noFallback) {
    expect(
      seen.fallback,
      `the ${sc.s} loading() fallback must not appear`,
    ).toBe(false);
  }
  expect(seen.detached, "a boundary on screen must not be detached").toBe(
    false,
  );
}

export function runZeroLoaderBoundaryTests(
  options: ZeroLoaderBoundaryScenarioOptions,
): void {
  const { url } = options;

  // A dev server that optimizes a dependency on the first visit reloads the
  // page once; load again rather than time out on that reload.
  const waitForHydration = async (page: Page, pathname: string) => {
    try {
      await options.waitForHydration(page);
    } catch {
      await page.goto(url(pathname));
      await options.waitForHydration(page);
    }
  };

  for (const sc of SCENARIOS) {
    test(`${sc.name}: a plain click to an un-prefetched sibling after a fully prefetched click keeps what is on screen`, async ({
      page,
    }) => {
      const bRequests = trackRequestsFor(page, `/${sc.s}/b`);
      await page.goto(url("/zlb"));
      await waitForHydration(page, "/zlb");

      const prefetched = page.waitForResponse((resp) => {
        const u = new URL(resp.url());
        return (
          u.pathname === `/${sc.s}/a` && u.searchParams.has("_rsc_partial")
        );
      });
      await page.hover(`[data-testid="${sc.s}-hub-prefetched"]`);
      await (await prefetched).finished();

      await page.locator(`[data-testid="${sc.s}-hub-prefetched"]`).click();
      await clickThroughToB(page, sc, bRequests);
    });

    test(`${sc.name}, control: entering by a plain click, then a plain click`, async ({
      page,
    }) => {
      const bRequests = trackRequestsFor(page, `/${sc.s}/b`);
      await page.goto(url("/zlb"));
      await waitForHydration(page, "/zlb");

      await page.locator(`[data-testid="${sc.s}-hub-plain"]`).click();
      await clickThroughToB(page, sc, bRequests);
    });

    test(`${sc.name}, control: loading the document, then a plain click`, async ({
      page,
    }) => {
      const bRequests = trackRequestsFor(page, `/${sc.s}/b`);
      await page.goto(url(`/${sc.s}/a`));
      await waitForHydration(page, `/${sc.s}/a`);

      await clickThroughToB(page, sc, bRequests);
    });
  }
}
