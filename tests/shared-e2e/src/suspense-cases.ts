import { expect, test, type Page } from "@playwright/test";
import { readSuspenseAudit, resetSuspenseAudit } from "./console-guard.js";
import { readProbe, watchFlash } from "./flash-probe.js";

/**
 * The suspense contract, flow by flow (docs/internal/suspense-contract.md):
 * content on screen is never replaced by a fallback it does not need, a
 * boundary on screen keeps the thenable it waits for, and a segment that
 * stays on the page keeps its mount. Fixtures: suspense-cases.tsx in each
 * app, plus the clientUrls slow group both apps already share. Both apps
 * call this from a dev and a (production) describe.
 *
 * Four assertions per case: the flash probe (DOM, both modes), the mounted
 * instance of what is held (both modes), the router's suspense audit at zero
 * and the tree updates each user step handed React (both dev only: a build
 * carries no audit and React prints no warnings). The console guard covers
 * every dev test on top (console-guard.ts).
 *
 * `RANGO_SUSPENSE_MEASURE=1` prints the tree updates and commit counts each
 * step produced instead of asserting them.
 */

const MEASURE = process.env.RANGO_SUSPENSE_MEASURE === "1";

/** What may hand React a tree (src/suspense-audit.ts, I6). */
type TreeUpdates = Partial<
  Record<
    | "navigation"
    | "popstate"
    | "stale-revalidation"
    | "action"
    | "error"
    | "hmr",
    // A count, or the range the step's timing leaves open.
    number | [min: number, max: number]
  >
>;

export interface SuspenseCasesOptions {
  url: (pathname: string) => string;
  waitForHydration: (page: Page) => Promise<void>;
  production: boolean;
  /**
   * Cases that are red today, by title, with the reason. An open case is an
   * expected failure: it is reported while it fails and fails the run the
   * day it passes, so the entry gets removed.
   */
  open?: Record<string, string>;
}

type Counter =
  | "swaps"
  | "untracked"
  | "idleFallbacks"
  | "resuspended"
  | "remounts"
  | "drifts"
  | "uncaused";

const COUNTERS: Counter[] = [
  "uncaused",
  "swaps",
  "untracked",
  "idleFallbacks",
  "resuspended",
  "remounts",
  "drifts",
];

// One per click: the first click's tree commits when its payload arrives,
// with its loader still streaming, unless the second click got there first.
const SUPERSEDED: TreeUpdates = { navigation: [1, 2] };
// One per back/forward, and one more only when the stored page was stale.
const BACK_FROM_INTERCEPT: TreeUpdates = { popstate: 1 };
const BACK_TO_STORED: TreeUpdates = { popstate: 1 };
// The revalidation of a stale page is a tree update only when it brings
// something: here no loader re-runs, and main hands React nothing for it.
const BACK_TO_STALE: TreeUpdates = {
  popstate: 1,
  "stale-revalidation": [0, 1],
};

// A missing probe reads as "no flash, nothing detached" (flash-probe.ts).
const PROBE_LOST = "the flash probe is still installed at the read";

const testId = (page: Page, id: string) =>
  page.locator(`[data-testid="${id}"]`);

/** The value ScInstance shows once mounted: another value is another mount. */
async function instance(page: Page, id: string): Promise<string> {
  const marker = testId(page, `sc-instance-${id}`);
  await expect(marker).not.toHaveText("");
  return (await marker.textContent()) ?? "";
}

// Open cases by title, with the reason (docs/internal/suspense-contract.md,
// "The cases"). Remove an entry when its case passes.
const ONE_COMMIT =
  "#1079: a clientUrls() navigation presents its destination at the click, and the server's answer and the clearing of the intent commit it again; its reader is handed a gate that never settles, then the real promise";
export const SUSPENSE_CASES_OPEN_DEV: Record<string, string> = {
  "a clientUrls() navigation to a route with an inline boundary is one commit":
    ONE_COMMIT,
  "a clientUrls() navigation to a route with loading() is one commit":
    ONE_COMMIT,
  "a clientUrls() same-route navigation is one commit": ONE_COMMIT,
};
// A build only: in dev the fallback shows while a client reference loads.
export const SUSPENSE_CASES_OPEN_PRODUCTION: Record<string, string> = {
  ...SUSPENSE_CASES_OPEN_DEV,
  "a client component directly in a route's content does not show the route's loading() on a cold click":
    "#1079: the click is the first use of the client component's module in the document; its chunk is already fetched, but the Flight client waits for the module's import() (3 to 6 ms) and the route's loading() is the nearest boundary: 300 ms. Likely fix, not built: #1084 candidate a (src/browser/settle-client-references.ts on experiment/vt-idle-transition), which settles a payload's client references before its first commit",
};

/**
 * One app's `suspense cases (dev)` or `suspense cases (production)` describe:
 * `mode: "build"` and the `(production)` title come from here together.
 * `fixture` is the app's useFixture() for that mode, called inside the
 * describe.
 */
export function describeSuspenseCases(
  mode: "dev" | "build",
  waitForHydration: (page: Page) => Promise<void>,
  fixture: () => { url: (pathname: string) => string },
): void {
  const production = mode === "build";
  test.describe(`suspense cases (${production ? "production" : "dev"})`, () => {
    const f = fixture();
    test.setTimeout(60000);
    runSuspenseCases({
      url: (pathname) => f.url(pathname),
      waitForHydration,
      production,
      open: production
        ? SUSPENSE_CASES_OPEN_PRODUCTION
        : SUSPENSE_CASES_OPEN_DEV,
    });
  });
}

export function runSuspenseCases(options: SuspenseCasesOptions): void {
  const { url, waitForHydration, production, open = {} } = options;

  function it(title: string, body: (page: Page) => Promise<void>): void {
    test(title, async ({ page }) => {
      test.fail(title in open, open[title]);
      await body(page);
    });
  }

  /** The audit's counters, zero unless `expected` says otherwise. Dev only. */
  async function expectAudit(
    page: Page,
    expected: Partial<Record<Counter, number | "any">> = {},
  ): Promise<void> {
    if (production) return;
    // The audit reports a fallback two microtasks after it mounts.
    await page.evaluate(() => new Promise((r) => setTimeout(r, 0)));
    const audit = await readSuspenseAudit(page);
    expect(audit, "a dev build exposes the suspense audit").not.toBeNull();
    for (const counter of COUNTERS) {
      const want = expected[counter] ?? 0;
      if (want === "any") continue;
      expect(
        audit![counter],
        `${counter}: ${JSON.stringify(audit!.events)}`,
      ).toBe(want);
    }
  }

  /**
   * The tree updates React was handed for one user step, by cause (I6): one
   * per click, one per action, one per back/forward, none for anything that
   * updates in place. Dev only. Call the returned function after each step.
   */
  async function trackTreeUpdates(
    page: Page,
  ): Promise<(expected: TreeUpdates, step: string) => Promise<void>> {
    const read = async (): Promise<Record<string, number>> =>
      (await readSuspenseAudit(page))?.treeUpdates ?? {};
    let before = production ? {} : await read();
    return async (expected, step) => {
      if (production) return;
      await page.evaluate(() => new Promise((r) => setTimeout(r, 0)));
      const now = await read();
      const delta: Record<string, number> = {};
      for (const [cause, count] of Object.entries(now)) {
        const added = count - (before[cause] ?? 0);
        if (added !== 0) delta[cause] = added;
      }
      before = now;
      if (MEASURE) {
        console.log(
          `[measure] ${test.info().title} | ${step} | ${JSON.stringify(delta)}`,
        );
        return;
      }
      const exact: Record<string, number> = {};
      for (const [cause, want] of Object.entries(expected)) {
        if (typeof want === "number") {
          if (want !== 0) exact[cause] = want;
          continue;
        }
        const got = delta[cause] ?? 0;
        expect(got, `${cause} tree updates for ${step}`).toBeGreaterThanOrEqual(
          want[0],
        );
        expect(got, `${cause} tree updates for ${step}`).toBeLessThanOrEqual(
          want[1],
        );
        if (got !== 0) exact[cause] = got;
      }
      expect(delta, `tree updates for ${step}`).toEqual(exact);
    };
  }

  async function fromHub(page: Page, link: string): Promise<void> {
    await page.goto(url("/sc"));
    await waitForHydration(page);
    await testId(page, link).click();
  }

  async function expectNoFlash(page: Page, what: string): Promise<void> {
    const seen = await readProbe(page);
    expect(seen.installed, PROBE_LOST).toBe(true);
    expect(seen.flash, `${what} must not appear`).toBe(false);
    expect(seen.detached, "content on screen must not be detached").toBe(false);
  }

  it("same-route navigation outside a transition scope remounts the route and keeps the layout", async (page) => {
    await fromHub(page, "sc-hub-plain-1");
    await expect(testId(page, "sc-item-value")).toHaveText(/^item-1-/);
    const shell = await instance(page, "shell");
    const route = await instance(page, "route");
    await resetSuspenseAudit(page);
    const updates = await trackTreeUpdates(page);

    await watchFlash(page, "sc-shell-fallback", ["sc-shell"]);
    await testId(page, "sc-to-plain-2").click();
    await expect(testId(page, "sc-plain-id")).toHaveText("2");
    await expect(testId(page, "sc-item-value")).toHaveText(/^item-2-/);
    await updates({ navigation: 1 }, "one click");

    await expectNoFlash(page, "the layout's loading() fallback");
    expect(await instance(page, "shell"), "the layout is held").toBe(shell);
    // The documented remount: a param-bearing key (docs/tree-structure.md).
    expect(await instance(page, "route"), "the route remounts").not.toBe(route);
    await expectAudit(page);
  });

  it("same-route navigation inside a transition scope reconciles the route", async (page) => {
    await fromHub(page, "sc-hub-tx-1");
    await expect(testId(page, "sc-tx-value")).toHaveText(/^item-1-/);
    const shell = await instance(page, "tx-shell");
    const route = await instance(page, "tx-route");
    await resetSuspenseAudit(page);
    const updates = await trackTreeUpdates(page);

    await watchFlash(page, "sc-tx-fallback", ["sc-tx-shell", "sc-tx"]);
    await testId(page, "sc-to-tx-2").click();
    await expect(testId(page, "sc-tx-id")).toHaveText("2");
    await expect(testId(page, "sc-tx-value")).toHaveText(/^item-2-/);
    await updates({ navigation: 1 }, "one click");

    await expectNoFlash(page, "the route's loading() fallback");
    expect(await instance(page, "tx-shell"), "the layout is held").toBe(shell);
    expect(await instance(page, "tx-route"), "the route is held").toBe(route);
    await expectAudit(page);
  });

  it("an action that re-runs one of two loaders keeps the other reader on screen", async (page) => {
    await fromHub(page, "sc-hub-two");
    await expect(testId(page, "sc-a-value")).toHaveText(/^a-/);
    const a = await testId(page, "sc-a-value").textContent();
    const b = await testId(page, "sc-b-value").textContent();
    const two = await instance(page, "two");
    await resetSuspenseAudit(page);
    const updates = await trackTreeUpdates(page);

    await watchFlash(page, "sc-two-fallback", ["sc-two", "sc-b-value"]);
    await testId(page, "sc-action").click();
    await expect(testId(page, "sc-a-value")).not.toHaveText(a!);
    await expect(testId(page, "sc-b-value")).toHaveText(b!);
    await updates({ action: 1 }, "one action");

    await expectNoFlash(page, "the route's loading() fallback");
    expect(await instance(page, "two"), "the route is held").toBe(two);
    await expectAudit(page);
  });

  it("an action commit transition({ when }) gated off shows no fallback when its data is in hand", async (page) => {
    await fromHub(page, "sc-hub-when-a");
    await expect(testId(page, "sc-when-value")).toHaveText(/^item-a-/);
    const value = await testId(page, "sc-when-value").textContent();
    const when = await instance(page, "when");
    await resetSuspenseAudit(page);
    const updates = await trackTreeUpdates(page);

    await watchFlash(page, "sc-when-fallback", ["sc-when"]);
    await testId(page, "sc-action").click();
    await expect(testId(page, "sc-action")).toHaveText(/^actions:[1-9]\d*$/);
    await expect(testId(page, "sc-when-value")).not.toHaveText(value!);
    await updates({ action: 1 }, "one action");

    await expectNoFlash(page, "the route's loading() fallback");
    expect(await instance(page, "when"), "the route is held").toBe(when);
    await expectAudit(page);
  });

  it("transition({ when }) flipping true, false, true keeps the route mounted", async (page) => {
    await fromHub(page, "sc-hub-when-a");
    await expect(testId(page, "sc-when-value")).toHaveText(/^item-a-/);
    const when = await instance(page, "when");
    await resetSuspenseAudit(page);
    const updates = await trackTreeUpdates(page);

    // c is held, b is gated off (urgent: its fallback shows again while the
    // new data streams, by design), a is held again.
    for (const n of ["c", "b", "a"]) {
      await testId(page, `sc-to-when-${n}`).click();
      await expect(testId(page, "sc-when-n")).toHaveText(n);
      await expect(testId(page, "sc-when-value")).toHaveText(
        new RegExp(`^item-${n}-`),
      );
      expect(await instance(page, "when"), `held through ${n}`).toBe(when);
      await updates({ navigation: 1 }, `the click to ${n}`);
    }
    await expectAudit(page);
    if (!production) {
      // The gated-off step is the audit telling a fallback that waits for
      // data apart from one that waits for nothing.
      const audit = await readSuspenseAudit(page);
      expect(audit!.shownWhilePending).toBeGreaterThan(0);
    }
  });

  it("a boundary re-rendered while its data streams keeps the promise it waits for", async (page) => {
    await page.goto(url("/sc"));
    await waitForHydration(page);
    const updates = await trackTreeUpdates(page);
    await watchFlash(page, "sc-slow-fallback");
    await testId(page, "sc-hub-slow").click();
    // The navigation state changes while the loader streams, and ScNavState
    // re-renders with each change.
    await expect(testId(page, "sc-slow-value")).toHaveText(/^slow-/);
    await expect(testId(page, "sc-nav")).toHaveText("idle");
    const seen = await readProbe(page);
    expect(seen.installed, PROBE_LOST).toBe(true);
    expect(seen.flash, "the route streamed behind its fallback").toBe(true);
    // The loader's data reached its reader through the promise it waited on.
    await updates({ navigation: 1 }, "one click and its streamed data");
    await expectAudit(page);
  });

  it("a navigation superseded by a second click commits a silent page", async (page) => {
    await fromHub(page, "sc-hub-plain-1");
    await expect(testId(page, "sc-item-value")).toHaveText(/^item-1-/);
    const shell = await instance(page, "shell");
    await resetSuspenseAudit(page);
    const updates = await trackTreeUpdates(page);

    await testId(page, "sc-to-slow").click();
    await testId(page, "sc-to-plain-2").click();
    await expect(testId(page, "sc-plain-id")).toHaveText("2");
    await expect(testId(page, "sc-item-value")).toHaveText(/^item-2-/);
    await expect(testId(page, "sc-slow")).toHaveCount(0);
    expect(new URL(page.url()).pathname).toBe("/sc/plain/2");
    await updates(SUPERSEDED, "two clicks, the first superseded");
    expect(await instance(page, "shell"), "the layout is held").toBe(shell);
    await expectAudit(page);
  });

  it("a document load of a streaming page hydrates silently", async (page) => {
    await page.goto(url("/sc/slow"));
    await waitForHydration(page);
    await expect(testId(page, "sc-slow-value")).toHaveText(/^slow-/);
    await expect(testId(page, "sc-shell-value")).toHaveText(/^shell-/);
    const updates = await trackTreeUpdates(page);
    if (!production && !MEASURE) {
      const audit = await readSuspenseAudit(page);
      expect(
        audit!.treeUpdates,
        "a document load hands React no update",
      ).toEqual({});
    }
    await updates({}, "the document load");
    await expectAudit(page);
  });

  it("an intercept opened and closed keeps the page under it mounted", async (page) => {
    await fromHub(page, "sc-hub-list");
    await expect(testId(page, "sc-list")).toBeVisible();
    const shell = await instance(page, "shell");
    const list = await instance(page, "list");
    await resetSuspenseAudit(page);
    const updates = await trackTreeUpdates(page);

    await watchFlash(page, "sc-shell-fallback", ["sc-shell", "sc-list"]);
    await testId(page, "sc-to-detail-1").click();
    await expect(testId(page, "sc-modal")).toBeVisible();
    await expect(testId(page, "sc-list")).toBeVisible();
    await updates({ navigation: 1 }, "the click that opens the intercept");
    await page.goBack();
    await expect(testId(page, "sc-modal")).toHaveCount(0);
    await expect(testId(page, "sc-list")).toBeVisible();
    await updates(BACK_FROM_INTERCEPT, "the back that closes it");

    await expectNoFlash(page, "the layout's loading() fallback");
    expect(await instance(page, "shell"), "the layout is held").toBe(shell);
    expect(await instance(page, "list"), "the page is held").toBe(list);
    await expectAudit(page);
  });

  it("a loader read by the layout above its route, across a navigation and an action", async (page) => {
    await fromHub(page, "sc-hub-above-1");
    await expect(testId(page, "sc-above-value")).toHaveText(/^item-1-/);
    const above = await instance(page, "above");
    await resetSuspenseAudit(page);
    const updates = await trackTreeUpdates(page);

    await testId(page, "sc-to-above-2").click();
    await expect(testId(page, "sc-above-value")).toHaveText(/^item-2-/);
    expect(await instance(page, "above"), "held by the navigation").toBe(above);
    await updates({ navigation: 1 }, "one click");

    const value = await testId(page, "sc-above-value").textContent();
    await testId(page, "sc-action").click();
    await expect(testId(page, "sc-above-value")).not.toHaveText(value!);
    await expect(testId(page, "sc-above-value")).toHaveText(/^item-2-/);
    expect(await instance(page, "above"), "held by the action").toBe(above);
    await updates({ action: 1 }, "one action");
    await expectAudit(page);
  });

  it("a document load, then the first client navigation, keeps the layout mounted", async (page) => {
    await page.goto(url("/sc/plain/1"));
    await waitForHydration(page);
    await expect(testId(page, "sc-item-value")).toHaveText(/^item-1-/);
    const shell = await instance(page, "shell");
    await resetSuspenseAudit(page);
    const updates = await trackTreeUpdates(page);

    await watchFlash(page, "sc-shell-fallback", ["sc-shell"]);
    await testId(page, "sc-to-plain-2").click();
    await expect(testId(page, "sc-plain-id")).toHaveText("2");
    await expect(testId(page, "sc-item-value")).toHaveText(/^item-2-/);
    await updates({ navigation: 1 }, "the first client navigation");

    await expectNoFlash(page, "the layout's loading() fallback");
    expect(await instance(page, "shell"), "the layout is held").toBe(shell);
    await expectAudit(page);
  });

  it("an action refetch, a refresh and a back/forward restore keep every wrapper chain", async (page) => {
    await fromHub(page, "sc-hub-plain-1");
    await expect(testId(page, "sc-item-value")).toHaveText(/^item-1-/);
    const shell = await instance(page, "shell");
    const route = await instance(page, "route");
    await resetSuspenseAudit(page);
    const updates = await trackTreeUpdates(page);

    let value = await testId(page, "sc-item-value").textContent();
    await testId(page, "sc-action").click();
    await expect(testId(page, "sc-item-value")).not.toHaveText(value!);
    await updates({ action: 1 }, "one action");
    value = await testId(page, "sc-item-value").textContent();
    await testId(page, "sc-refresh").click();
    await expect(testId(page, "sc-item-value")).not.toHaveText(value!);
    await updates({ navigation: 1 }, "one refresh");
    expect(await instance(page, "shell"), "the layout is held").toBe(shell);
    expect(await instance(page, "route"), "the route is held").toBe(route);

    await testId(page, "sc-to-list").click();
    await expect(testId(page, "sc-list")).toBeVisible();
    await updates({ navigation: 1 }, "one click");
    await page.goBack();
    await expect(testId(page, "sc-item-value")).toHaveText(/^item-1-/);
    await updates(BACK_TO_STORED, "one back to a stored page");
    expect(await instance(page, "shell"), "the layout is held").toBe(shell);
    // The tree shape is this case's subject: the other counters belong to
    // the cases above.
    await expectAudit(page, {
      swaps: "any",
      untracked: "any",
      idleFallbacks: "any",
      resuspended: "any",
    });
  });

  it("a back to a page an action made stale is one restore, and one more update only for what its revalidation brings", async (page) => {
    await fromHub(page, "sc-hub-plain-1");
    await expect(testId(page, "sc-item-value")).toHaveText(/^item-1-/);
    const stored = await testId(page, "sc-item-value").textContent();
    const shell = await instance(page, "shell");
    await testId(page, "sc-to-two").click();
    await expect(testId(page, "sc-a-value")).toHaveText(/^a-/);
    const updates = await trackTreeUpdates(page);

    const a = await testId(page, "sc-a-value").textContent();
    await testId(page, "sc-action").click();
    await expect(testId(page, "sc-a-value")).not.toHaveText(a!);
    await updates({ action: 1 }, "one action");

    // The stored page at once, then its revalidation in the background.
    const revalidated = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/sc/plain/1" &&
        new URL(response.url()).searchParams.has("_rsc_partial"),
      { timeout: 15000 },
    );
    await page.goBack();
    await expect(testId(page, "sc-plain-id")).toHaveText("1");
    await expect(testId(page, "sc-item-value")).toHaveText(stored!);
    await (await revalidated).finished();
    await expect(testId(page, "sc-nav")).toHaveText("idle");
    await updates(BACK_TO_STALE, "one back to a page an action made stale");
    expect(await instance(page, "shell"), "the layout is held").toBe(shell);
  });

  it("a slot whose component arrives as a promise, then as a node, is not remounted", async (page) => {
    await fromHub(page, "sc-hub-slot-fast");
    await expect(testId(page, "sc-side-id")).toHaveText("fast");
    const side = await instance(page, "side");
    await resetSuspenseAudit(page);
    const updates = await trackTreeUpdates(page);

    await testId(page, "sc-to-slot-slow").click();
    await expect(testId(page, "sc-side-id")).toHaveText("slow");
    expect(await instance(page, "side"), "held as a promise").toBe(side);
    await updates({ navigation: 1 }, "the click to the slow slot");
    await testId(page, "sc-to-slot-fast").click();
    await expect(testId(page, "sc-side-id")).toHaveText("fast");
    expect(await instance(page, "side"), "held as a node").toBe(side);
    await updates({ navigation: 1 }, "the click to the fast slot");
    await expectAudit(page);
  });

  it("a clientUrls() destination presented at the click is not remounted by the server's answer", async (page) => {
    await page.goto(url("/client-urls-slow"));
    await waitForHydration(page);
    await expect(testId(page, "cus-a")).toBeVisible();
    await resetSuspenseAudit(page);

    await testId(page, "cus-a-to-b").click();
    // The destination renders at the click; its loader arrives with the
    // server's answer, 5 s later.
    await expect(testId(page, "cus-b")).toBeVisible();
    await expect(testId(page, "cus-b-skeleton")).toBeVisible();
    await testId(page, "cus-b-input").fill("kept");
    await watchFlash(page, "cus-none", ["cus-b"]);
    await expect(testId(page, "cus-b-loader")).toBeVisible({ timeout: 15000 });

    const seen = await readProbe(page);
    expect(seen.installed, PROBE_LOST).toBe(true);
    expect(seen.detached, "the destination must not be detached").toBe(false);
    await expect(testId(page, "cus-b-input")).toHaveValue("kept");
    await expectAudit(page);
  });

  it("a prefetched clientUrls() route with a loader commits silently", async (page) => {
    await page.goto(url("/client-urls-slow/b/first"));
    await waitForHydration(page);
    await expect(testId(page, "cus-b-loader")).toBeVisible();
    await resetSuspenseAudit(page);
    const updates = await trackTreeUpdates(page);

    const prefetched = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/client-urls-slow/c" &&
        new URL(response.url()).searchParams.has("_rsc_partial"),
      { timeout: 15000 },
    );
    await testId(page, "cus-b-to-c").hover();
    await (await prefetched).finished();
    await updates({}, "a prefetch");
    await testId(page, "cus-b-to-c").click();
    await expect(testId(page, "cus-c-loader")).toBeVisible();
    await updates({ navigation: 1 }, "one click");
    await expectAudit(page);
  });

  it("a route whose loaders are all read behind their own boundaries shows its page, not its loading() fallback", async (page) => {
    await page.goto(url("/sc"));
    await waitForHydration(page);
    const updates = await trackTreeUpdates(page);

    await watchFlash(page, "sc-own-fallback");
    await testId(page, "sc-hub-own-1").click();
    await expect(testId(page, "sc-own-a-value")).toHaveText(/^own-a-/);
    await expect(testId(page, "sc-own-b-value")).toHaveText(/^own-b-/);
    await updates({ navigation: 1 }, "one click and two streamed loaders");
    const seen = await readProbe(page);
    expect(seen.installed, PROBE_LOST).toBe(true);
    if (MEASURE) {
      const audit = production ? null : await readSuspenseAudit(page);
      console.log(
        `[measure] ${test.info().title} | ${production ? "production" : "dev"} | flash ${seen.flash} | ${JSON.stringify(audit?.events ?? [])}`,
      );
      return;
    }
    // Nothing the route's own boundary waits for is pending: each loader has
    // a boundary of its own. A dev build shows the fallback while a client
    // reference loads, so the DOM assertion is for a build.
    if (production) {
      expect(seen.flash, "the route's loading() fallback").toBe(false);
    }
    await expectAudit(page);
  });

  it("a client component directly in a route's content does not show the route's loading() on a cold click", async (page) => {
    await page.goto(url("/sc"));
    await waitForHydration(page);
    const updates = await trackTreeUpdates(page);

    await watchFlash(page, "sc-top-fallback");
    await testId(page, "sc-hub-top-1").click();
    await expect(testId(page, "sc-own-a-value")).toHaveText(/^own-a-/);
    await expect(testId(page, "sc-own-b-value")).toHaveText(/^own-b-/);
    await updates({ navigation: 1 }, "one click and two streamed loaders");
    const seen = await readProbe(page);
    expect(seen.installed, PROBE_LOST).toBe(true);
    if (MEASURE) {
      const audit = production ? null : await readSuspenseAudit(page);
      console.log(
        `[measure] ${test.info().title} | ${production ? "production" : "dev"} | flash ${seen.flash} | ${JSON.stringify(audit?.events ?? [])}`,
      );
      return;
    }
    // The route's content is handed over settled. The click is the first use
    // of its client component's module in the document (the hub renders none
    // of them): the chunk is already fetched, but the Flight client waits for
    // the module's import(). A dev build shows the fallback while a client
    // reference loads anyway, so the DOM assertion is for a build.
    if (production) {
      expect(seen.flash, "the route's loading() fallback").toBe(false);
    }
    await expectAudit(page);
  });

  it("a loader refetched where it is read updates in place, with no tree update", async (page) => {
    await fromHub(page, "sc-hub-live");
    await expect(testId(page, "sc-live-value")).toHaveText(/^live-/);
    const live = await instance(page, "live");
    await resetSuspenseAudit(page);
    const updates = await trackTreeUpdates(page);

    await watchFlash(page, "sc-live-fallback", ["sc-live", "sc-live-value"]);
    const value = await testId(page, "sc-live-value").textContent();
    await testId(page, "sc-reload").click();
    await expect(testId(page, "sc-live-value")).not.toHaveText(value!);
    // useLoader().load(): the loader store notifies its readers.
    await updates({}, "a loader refetch");

    await expectNoFlash(page, "the reader's fallback");
    expect(await instance(page, "live"), "the page is held").toBe(live);
    await expectAudit(page);
  });

  it("a handle pushed after the page committed reaches its reader with no tree update", async (page) => {
    await page.goto(url("/sc"));
    await waitForHydration(page);
    const updates = await trackTreeUpdates(page);

    await testId(page, "sc-hub-live").click();
    await expect(testId(page, "sc-live")).toBeVisible();
    await expect(testId(page, "sc-live-value")).toHaveText(/^live-/);
    const live = await instance(page, "live");
    await updates({ navigation: 1 }, "one click");
    // The late push resolves 600 ms after the handler ran.
    await expect(testId(page, "sc-notes")).toHaveText("with-the-page,late");
    await updates({}, "the handle's late push");
    expect(await instance(page, "live"), "the page is held").toBe(live);
    await expectAudit(page);
  });

  it("a prefetch hands React no tree, and the click it serves hands it one", async (page) => {
    await page.goto(url("/sc"));
    await waitForHydration(page);
    const updates = await trackTreeUpdates(page);

    const prefetched = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/sc/plain/1" &&
        new URL(response.url()).searchParams.has("_rsc_partial"),
      { timeout: 15000 },
    );
    await testId(page, "sc-hub-plain-1-pf").hover();
    await (await prefetched).finished();
    await updates({}, "a prefetch");
    await testId(page, "sc-hub-plain-1-pf").click();
    await expect(testId(page, "sc-item-value")).toHaveText(/^item-1-/);
    await updates({ navigation: 1 }, "one click");
  });

  /**
   * One clientUrls() navigation, counted: the tree updates the router hands
   * React (dev), the commits that render the destination and its loader's
   * reader (useSlowCommits in the fixture, both modes), and the thenables
   * the reader is handed (dev). The target is one of each. The group sits
   * behind a 5 s middleware, so the click and the server's answer are far
   * apart.
   */
  async function countClientUrlsNavigation(
    page: Page,
    flow: {
      click: string;
      /** Where the click goes: the chrome outside the group shows it once
       *  the server's answer committed. */
      path: string;
      destination: string;
      reader: string;
      loaded: string;
    },
  ): Promise<void> {
    await resetSuspenseAudit(page);
    await page.evaluate(() => {
      (window as { __cusCommits?: Record<string, number> }).__cusCommits = {};
    });
    const updates = await trackTreeUpdates(page);

    await testId(page, flow.click).click();
    await expect(testId(page, "cus-chrome-pathname")).toHaveText(flow.path, {
      timeout: 15000,
    });
    await expect(testId(page, flow.loaded)).toBeVisible();
    // The intent is cleared in a transition after the canonical commit.
    await page.waitForTimeout(500);

    const commits = await page.evaluate(
      () =>
        (window as { __cusCommits?: Record<string, number> }).__cusCommits ??
        {},
    );
    const audit = production ? null : await readSuspenseAudit(page);
    const handed = audit
      ? Object.entries(audit.handed)
          .filter(
            ([key]) =>
              key.startsWith("read:") && key.endsWith("ClientUrlsSlowLoader"),
          )
          .reduce((sum, [, count]) => sum + count, 0)
      : null;
    if (MEASURE) {
      console.log(
        `[measure] ${test.info().title} | ${production ? "production" : "dev"} | commits ${JSON.stringify(commits)} | swaps ${audit?.swaps} | handed ${handed} | ${JSON.stringify(audit?.handed ?? {})}`,
      );
    }
    await updates({ navigation: 1 }, "one click");
    if (MEASURE) return;
    expect(
      commits[flow.destination],
      "commits that rendered the destination",
    ).toBe(1);
    expect(commits[flow.reader], "commits that rendered its reader").toBe(1);
    if (audit) {
      expect(audit.swaps, "pending promises replaced under a reader").toBe(0);
      expect(handed, "promises the reader was handed").toBe(1);
    }
  }

  it("a clientUrls() navigation to a route with an inline boundary is one commit", async (page) => {
    await page.goto(url("/client-urls-slow"));
    await waitForHydration(page);
    await expect(testId(page, "cus-a")).toBeVisible();
    await countClientUrlsNavigation(page, {
      click: "cus-a-to-b",
      path: "/client-urls-slow/b/first",
      destination: "cus-b",
      reader: "cus-b-loader",
      loaded: "cus-b-loader",
    });
  });

  it("a clientUrls() navigation to a route with loading() is one commit", async (page) => {
    await page.goto(url("/client-urls-slow"));
    await waitForHydration(page);
    await expect(testId(page, "cus-a")).toBeVisible();
    await countClientUrlsNavigation(page, {
      click: "cus-a-to-f",
      path: "/client-urls-slow/f",
      destination: "cus-f",
      reader: "cus-f",
      loaded: "cus-f-loader",
    });
  });

  it("a clientUrls() same-route navigation is one commit", async (page) => {
    await page.goto(url("/client-urls-slow/b/first"));
    await waitForHydration(page);
    await expect(testId(page, "cus-b-loader")).toBeVisible();
    await expect(testId(page, "cus-b-param")).toHaveText("first");
    await countClientUrlsNavigation(page, {
      click: "cus-b-to-b-note",
      path: "/client-urls-slow/b/second",
      destination: "cus-b",
      reader: "cus-b-loader",
      loaded: "cus-b-loader",
    });
    await expect(testId(page, "cus-b-param")).toHaveText("second");
  });

  it("entering a clientUrls() group from outside is one commit", async (page) => {
    await page.goto(url("/sc"));
    await waitForHydration(page);
    await countClientUrlsNavigation(page, {
      click: "sc-hub-cus-b",
      path: "/client-urls-slow/b/first",
      destination: "cus-b",
      reader: "cus-b-loader",
      loaded: "cus-b-loader",
    });
  });
}
