import { expect, test, type Page } from "@playwright/test";
import { readProbe, watchFlash } from "./flash-probe.js";

/**
 * A boundary on screen must not be replaced by its loading() fallback when
 * nothing in it is pending (src/segment-boundary-content.ts,
 * src/segment-loader-promise.ts). Fixture: held-boundary.tsx in each app; both
 * apps call this from a dev and a (production) describe.
 */

export interface HeldBoundaryScenarioOptions {
  url: (pathname: string) => string;
  waitForHydration: (page: Page) => Promise<void>;
  production: boolean;
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
  // cloudflare-basic compiles the router source with React Compiler, and the
  // compiled ParallelOutlet caches renderSlotContent(segment) on the segment's
  // identity while renderSegments mutates the slot segment in place
  // (segment-system.tsx, parallel slot loop). React never sees the swapped
  // promise there, so this scenario cannot go red in that app; it stays for
  // parity with the router test-app, where it does.
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

interface Entry {
  name: string;
  // Leaves the page on /<s>/a with /<s>/b never requested.
  enter: (page: Page, s: string, ctx: Ctx) => Promise<void>;
}

interface Ctx {
  url: (pathname: string) => string;
  waitForHydration: (page: Page) => Promise<void>;
}

const testId = (page: Page, id: string) =>
  page.locator(`[data-testid="${id}"]`);

async function fromHub(page: Page, ctx: Ctx): Promise<void> {
  await page.goto(ctx.url("/zlb"));
  await ctx.waitForHydration(page);
}

async function clickPrefetched(page: Page, s: string): Promise<void> {
  const prefetched = page.waitForResponse((resp) => {
    const u = new URL(resp.url());
    return u.pathname === `/${s}/a` && u.searchParams.has("_rsc_partial");
  });
  await page.hover(`[data-testid="${s}-hub-prefetched"]`);
  await (await prefetched).finished();
  await testId(page, `${s}-hub-prefetched`).click();
  await expect(testId(page, `${s}-a`)).toBeVisible();
}

const ENTRIES: Entry[] = [
  {
    name: "a fully prefetched click",
    enter: async (page, s, ctx) => {
      await fromHub(page, ctx);
      await clickPrefetched(page, s);
    },
  },
  {
    name: "a fully prefetched click, back and forward",
    enter: async (page, s, ctx) => {
      await fromHub(page, ctx);
      await clickPrefetched(page, s);
      await page.goBack();
      await expect(testId(page, "zlb-hub")).toBeVisible();
      await page.goForward();
      await expect(testId(page, `${s}-a`)).toBeVisible();
    },
  },
  {
    name: "a plain click",
    enter: async (page, s, ctx) => {
      await fromHub(page, ctx);
      await testId(page, `${s}-hub-plain`).click();
      await expect(testId(page, `${s}-a`)).toBeVisible();
    },
  },
  {
    name: "a document load",
    enter: async (page, s, ctx) => {
      await page.goto(ctx.url(`/${s}/a`));
      await ctx.waitForHydration(page);
      await expect(testId(page, `${s}-a`)).toBeVisible();
    },
  },
];

function trackRequestsFor(page: Page, pathname: string): string[] {
  const seen: string[] = [];
  page.on("request", (req) => {
    if (new URL(req.url()).pathname === pathname) seen.push(req.url());
  });
  return seen;
}

async function expectHeldVisible(page: Page, held: string[]): Promise<void> {
  for (const id of held) {
    await expect(testId(page, id)).toBeVisible();
  }
}

export function runHeldBoundaryTests(
  options: HeldBoundaryScenarioOptions,
): void {
  const { url, waitForHydration, production } = options;
  const ctx: Ctx = { url, waitForHydration };

  for (const sc of SCENARIOS) {
    for (const entry of ENTRIES) {
      test(`${sc.name}: after ${entry.name}, a plain click to an un-prefetched sibling keeps what is on screen`, async ({
        page,
      }) => {
        const bRequests = trackRequestsFor(page, `/${sc.s}/b`);
        await entry.enter(page, sc.s, ctx);
        await expectHeldVisible(page, sc.held);
        expect(bRequests, `/${sc.s}/b must not have been requested`).toEqual(
          [],
        );

        await watchFlash(page, `${sc.s}-fallback`, sc.held);
        await testId(page, `${sc.s}-to-b`).click();
        await expect(testId(page, `${sc.s}-b`)).toBeVisible();
        // A held boundary hidden behind its fallback is not visible until the
        // fallback goes, so this also waits out a flash before the probe is
        // read.
        await expectHeldVisible(page, sc.held);
        const seen = await readProbe(page);

        if (sc.noFallback) {
          expect(
            seen.flash,
            `the ${sc.s} loading() fallback must not appear`,
          ).toBe(false);
        }
        expect(seen.detached, "a boundary on screen must not be detached").toBe(
          false,
        );
      });
    }
  }

  test("a loading() boundary new to the page with nothing pending shows no fallback", async ({
    page,
  }) => {
    await fromHub(page, ctx);
    await watchFlash(page, "zlb-fallback");
    await testId(page, "zlb-hub-plain").click();
    await expect(testId(page, "zlb-a")).toBeVisible();
    await expect(testId(page, "zlb-layout")).toBeVisible();
    const seen = await readProbe(page);

    // Dev still shows the fallback on the first visit of a page's modules:
    // the content arrives, but a client reference the payload names is not
    // settled in that first render. Production has it settled, so none shows.
    if (production) {
      expect(seen.flash, "no fallback when nothing is pending").toBe(false);
    }
  });
}
