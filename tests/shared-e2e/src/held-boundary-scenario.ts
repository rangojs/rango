import { expect, test, type Page } from "@playwright/test";
import { readSuspenseAudit, resetSuspenseAudit } from "./console-guard.js";
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

// A missing probe reads as "no flash, nothing detached" (flash-probe.ts).
const PROBE_LOST = "the flash probe is still installed at the read";

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

  // Dev only: a build carries no suspense audit (src/suspense-audit.ts).
  async function expectAuditSilent(page: Page): Promise<void> {
    if (production) return;
    await page.evaluate(() => new Promise((r) => setTimeout(r, 0)));
    const audit = await readSuspenseAudit(page);
    expect(audit, "a dev build exposes the suspense audit").not.toBeNull();
    const {
      events,
      shownWhilePending: _byDesign,
      unattributedFallbacks: _unattributed,
      treeUpdates: _updates,
      handed: _handed,
      // I7 is the console guard's (tools/e2e-console-baseline.json).
      mutations: _mutations,
      ...counters
    } = audit!;
    expect(counters, JSON.stringify(events)).toEqual({
      uncaused: 0,
      swaps: 0,
      untracked: 0,
      idleFallbacks: 0,
      resuspended: 0,
      remounts: 0,
      drifts: 0,
    });
  }

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
        // The entry is held to the contract too.
        await expectAuditSilent(page);

        await resetSuspenseAudit(page);
        await watchFlash(page, `${sc.s}-fallback`, sc.held);
        await testId(page, `${sc.s}-to-b`).click();
        await expect(testId(page, `${sc.s}-b`)).toBeVisible();
        // A held boundary hidden behind its fallback is not visible until the
        // fallback goes, so this also waits out a flash before the probe is
        // read.
        await expectHeldVisible(page, sc.held);
        const seen = await readProbe(page);
        expect(seen.installed, PROBE_LOST).toBe(true);

        if (sc.noFallback) {
          expect(
            seen.flash,
            `the ${sc.s} loading() fallback must not appear`,
          ).toBe(false);
        }
        expect(seen.detached, "a boundary on screen must not be detached").toBe(
          false,
        );
        await expectAuditSilent(page);
      });
    }
  }

  // The start page shares an outer layout with the layout clicked into, so
  // the plain click mounts only the inner layout. Before #1080 the click to
  // the sibling then flashed the inner layout's fallback (301 ms in a build);
  // with the hub outside every layout (the scenarios above) it did not.
  test("layout with loading() inside an outer layout: after a plain click from a page in the outer layout, a plain click to an un-prefetched sibling keeps what is on screen", async ({
    page,
  }) => {
    const held = ["zlbo-outer", "zlbo-layout"];
    const bRequests = trackRequestsFor(page, "/zlbo/b");
    await page.goto(url("/zlbo"));
    await waitForHydration(page);
    await expect(testId(page, "zlbo-start")).toBeVisible();
    await testId(page, "zlbo-start-plain").click();
    await expect(testId(page, "zlbo-a")).toBeVisible();
    await expectHeldVisible(page, held);
    expect(bRequests, "/zlbo/b must not have been requested").toEqual([]);
    await expectAuditSilent(page);

    await resetSuspenseAudit(page);
    await watchFlash(page, "zlbo-fallback", held);
    await testId(page, "zlbo-to-b").click();
    await expect(testId(page, "zlbo-b")).toBeVisible();
    await expectHeldVisible(page, held);
    const seen = await readProbe(page);
    expect(seen.installed, PROBE_LOST).toBe(true);
    expect(seen.flash, "the zlbo loading() fallback must not appear").toBe(
      false,
    );
    expect(seen.detached, "a boundary on screen must not be detached").toBe(
      false,
    );
    await expectAuditSilent(page);
  });

  test("a loading() boundary new to the page with nothing pending renders, with no fallback in a build", async ({
    page,
  }) => {
    await fromHub(page, ctx);
    await watchFlash(page, "zlb-fallback");
    await testId(page, "zlb-hub-plain").click();
    await expect(testId(page, "zlb-a")).toBeVisible();
    await expect(testId(page, "zlb-layout")).toBeVisible();
    const seen = await readProbe(page);
    expect(seen.installed, PROBE_LOST).toBe(true);

    // The layout is new to the page, so this commit is urgent
    // (browser/partial-update.ts, the plain `onUpdate(update)` branch) and
    // anything still pending in it shows the fallback. A build has nothing
    // pending: the loader value is the shared empty array and the content is
    // a node.
    //
    // Dev shows the fallback for about 300 ms, on every payload and not only
    // on a first visit. Measured in the router test-app: the layout node
    // names a client reference (<Outlet>), which the Flight client hands to
    // that first render as a lazy still blocked on its module import (chunk
    // status "blocked", fulfilled 4 ms later), and React keeps a fallback it
    // has shown for 300 ms. The import is new each time because
    // @vitejs/plugin-rsc gives client reference ids a fresh `$$cache=` tag per
    // render in dev (createClientManifest) and memoizes the browser import on
    // the tagged id. A build has no tag, so the import is already settled and
    // the reference resolves during render.
    if (production) {
      expect(seen.flash, "no fallback when nothing is pending").toBe(false);
    }
  });
}
