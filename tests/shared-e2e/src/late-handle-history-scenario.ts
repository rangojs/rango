import { expect, test, type Page } from "@playwright/test";

/**
 * Late handle pushes on the document's late channel belong to the document's
 * page: its history entry, and the entries a shallow navigation copied from
 * it. Back restores them with the push; another page on screen never shows
 * it (rsc-router.tsx, late handle channel; navigation-store.ts,
 * liveHandleDataForCache and getPageHistoryKeys). Fixture: late-history.tsx
 * in each app; both apps call this from a dev and a (production) describe.
 */

export interface LateHandleHistoryScenarioOptions {
  url: (pathname: string) => string;
}

// The note loader pushes 300 ms after the request (?noteDelay overrides); the
// slow loader keeps the boundary (and the hydration window) open for SLOW_MS.
const SLOW_MS = 12000;
// A push that lands after the first click: long enough for hydration, which a
// warm-up load keeps short in dev.
const LATE_NOTE_MS = 3000;
const NOTE = "late history note";
const OTHER_NOTE = "other page note";

// Record the document's Flight text. The client replaces __FLIGHT_DATA.push
// (rsc-html-stream), so later rows never land in the array; the accessor wraps
// whichever push is installed.
async function recordFlightText(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const text: string[] = [];
    const data: unknown[] = [];
    let push: (chunk: unknown) => unknown = (chunk) =>
      Array.prototype.push.call(data, chunk);
    Object.defineProperty(data, "push", {
      get: () => (chunk: unknown) => {
        if (typeof chunk === "string") text.push(chunk);
        return push(chunk);
      },
      set: (next: typeof push) => {
        push = next;
      },
    });
    Object.assign(self, { __FLIGHT_DATA: data, __lhFlightText: text });
  });
}

// Runs in the page: the push's Flight row is in the document.
const pushArrived = (note: string): boolean =>
  (self as unknown as { __lhFlightText: string[] }).__lhFlightText
    .join("")
    .includes(note);

function flightHasNote(page: Page): Promise<boolean> {
  return page.evaluate(pushArrived, NOTE);
}

async function waitForLatePush(page: Page): Promise<void> {
  await page.waitForFunction(pushArrived, NOTE);
}

async function gotoLateHistory(
  page: Page,
  options: LateHandleHistoryScenarioOptions,
  search: string,
): Promise<void> {
  await page.goto(options.url(`/late-history/page?${search}`), {
    waitUntil: "commit",
  });
  await page.waitForFunction(() =>
    document.documentElement.hasAttribute("data-lh-mounted"),
  );
}

// Loads the fixture's modules once, so the timed load hydrates before its push.
async function warmUp(
  page: Page,
  options: LateHandleHistoryScenarioOptions,
): Promise<void> {
  await page.goto(options.url("/late-history/other"));
  await expect(page.getByTestId("lh-other")).toBeVisible();
  await page.waitForFunction(() =>
    document.documentElement.hasAttribute("data-lh-mounted"),
  );
}

// Every note list the reader showed from now on, as a joined snapshot.
async function recordShownNotes(page: Page): Promise<void> {
  await page.evaluate(() => {
    const shown: string[] = [];
    const snapshot = () =>
      Array.from(document.querySelectorAll('[data-testid="lh-note"]'))
        .map((node) => node.textContent ?? "")
        .join("|");
    shown.push(snapshot());
    new MutationObserver(() => shown.push(snapshot())).observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
    });
    Object.assign(self, { __lhShownNotes: shown });
  });
}

// The recorded snapshots that showed the document's late push.
function notesWithLatePush(page: Page): Promise<string[]> {
  return page.evaluate(
    (note) =>
      (self as unknown as { __lhShownNotes: string[] }).__lhShownNotes.filter(
        (notes) => notes.includes(note),
      ),
    NOTE,
  );
}

// The late channel applies a push a task or two after its row arrives
// (deferred-value resolution, then the debounced handle notification).
async function settle(page: Page): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((resolve) => setTimeout(resolve, 500)),
  );
}

export function runLateHandleHistoryTests(
  options: LateHandleHistoryScenarioOptions,
): void {
  test("Back after a navigation made during the hydration window keeps the late handle push", async ({
    page,
  }) => {
    test.setTimeout(60000);
    await recordFlightText(page);
    await gotoLateHistory(page, options, `delay=${SLOW_MS}`);
    await expect(page.getByTestId("lh-loading")).toBeVisible();
    // The push has reached the browser; the locked store still shows the
    // document's notes and the boundary is still streaming.
    await waitForLatePush(page);
    await expect(page.getByTestId("lh-slow-value")).toHaveCount(0);

    await page.getByTestId("lh-link-other").click();
    await expect(page.getByTestId("lh-other")).toBeVisible();

    await page.goBack();
    await expect(page).toHaveURL(/\/late-history\/page/);
    await expect(page.getByTestId("lh-note")).toHaveText([NOTE]);
  });

  test("a late handle push that arrives after a navigation to another page stays off that page and Back shows it", async ({
    page,
  }) => {
    test.setTimeout(60000);
    await recordFlightText(page);
    await warmUp(page, options);
    await gotoLateHistory(page, options, `delay=0&noteDelay=${LATE_NOTE_MS}`);
    expect(await flightHasNote(page), "the push lands after the click").toBe(
      false,
    );

    await page.getByTestId("lh-link-other").click();
    await expect(page.getByTestId("lh-other")).toBeVisible();
    await expect(page.getByTestId("lh-note")).toHaveText([OTHER_NOTE]);
    await recordShownNotes(page);

    await waitForLatePush(page);
    await settle(page);
    expect(await notesWithLatePush(page)).toEqual([]);
    await expect(page.getByTestId("lh-note")).toHaveText([OTHER_NOTE]);

    await page.goBack();
    await expect(page).toHaveURL(/\/late-history\/page\?delay=0/);
    await expect(page.getByTestId("lh-note")).toHaveText([NOTE]);
  });

  test("Back to a shallow entry made during the hydration window keeps a late handle push that arrived on it", async ({
    page,
  }) => {
    test.setTimeout(60000);
    await recordFlightText(page);
    await warmUp(page, options);
    await gotoLateHistory(
      page,
      options,
      `delay=${SLOW_MS}&noteDelay=${LATE_NOTE_MS}`,
    );
    expect(
      await flightHasNote(page),
      "the push lands after the shallow navigation",
    ).toBe(false);

    await page.getByTestId("lh-link-shallow").click();
    await expect(page).toHaveURL(/\/late-history\/page\?shallow=1$/);
    // The push arrives on the shallow entry while the window is still open.
    await waitForLatePush(page);
    await expect(page.getByTestId("lh-slow-value")).toHaveCount(0);

    await page.getByTestId("lh-link-other").click();
    await expect(page.getByTestId("lh-other")).toBeVisible();
    await expect(page.getByTestId("lh-note")).toHaveText([OTHER_NOTE]);

    await page.goBack();
    await expect(page).toHaveURL(/\/late-history\/page\?shallow=1$/);
    await expect(page.getByTestId("lh-note")).toHaveText([NOTE]);
  });

  test("a late handle push that arrives on a shallow entry shows on it", async ({
    page,
  }) => {
    test.setTimeout(60000);
    await recordFlightText(page);
    await warmUp(page, options);
    await gotoLateHistory(page, options, `delay=0&noteDelay=${LATE_NOTE_MS}`);
    expect(
      await flightHasNote(page),
      "the push lands after the shallow navigation",
    ).toBe(false);

    await page.getByTestId("lh-link-shallow").click();
    await expect(page).toHaveURL(/\/late-history\/page\?shallow=1$/);
    await waitForLatePush(page);
    await expect(page.getByTestId("lh-note")).toHaveText([NOTE]);
  });

  test("Back to a shallow entry keeps a late handle push that arrived after leaving it", async ({
    page,
  }) => {
    test.setTimeout(60000);
    await recordFlightText(page);
    await warmUp(page, options);
    await gotoLateHistory(page, options, `delay=0&noteDelay=${LATE_NOTE_MS}`);
    expect(await flightHasNote(page), "the push lands after leaving").toBe(
      false,
    );

    await page.getByTestId("lh-link-shallow").click();
    await expect(page).toHaveURL(/\/late-history\/page\?shallow=1$/);
    await page.getByTestId("lh-link-other").click();
    await expect(page.getByTestId("lh-other")).toBeVisible();
    await expect(page.getByTestId("lh-note")).toHaveText([OTHER_NOTE]);
    await recordShownNotes(page);

    await waitForLatePush(page);
    await settle(page);
    expect(await notesWithLatePush(page)).toEqual([]);
    await expect(page.getByTestId("lh-note")).toHaveText([OTHER_NOTE]);

    await page.goBack();
    await expect(page).toHaveURL(/\/late-history\/page\?shallow=1$/);
    await expect(page.getByTestId("lh-note")).toHaveText([NOTE]);
    await page.goBack();
    await expect(page).toHaveURL(/\/late-history\/page\?delay=0/);
    await expect(page.getByTestId("lh-note")).toHaveText([NOTE]);
  });
}
