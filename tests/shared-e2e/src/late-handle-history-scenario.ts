import { expect, test } from "@playwright/test";

/**
 * A late handle push, then a navigation while the hydration window is still
 * open, then Back: the restored page keeps the push. The history cache entry
 * the late push was written to must not be overwritten with the document
 * snapshot when the navigation leaves the page (navigation-store.ts,
 * liveHandleDataForCache). Fixture: late-history.tsx in each app; both apps
 * call this from a dev and a (production) describe.
 */

export interface LateHandleHistoryScenarioOptions {
  url: (pathname: string) => string;
}

// The note loader pushes 300 ms after the request; the slow loader keeps the
// boundary (and the hydration window) open for SLOW_MS.
const SLOW_MS = 12000;
const NOTE = "late history note";

export function runLateHandleHistoryTests(
  options: LateHandleHistoryScenarioOptions,
): void {
  test("Back after a navigation made during the hydration window keeps the late handle push", async ({
    page,
  }) => {
    test.setTimeout(60000);
    // Record the document's Flight text. The client replaces
    // __FLIGHT_DATA.push (rsc-html-stream), so later rows never land in the
    // array; the accessor wraps whichever push is installed.
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
    await page.goto(options.url(`/late-history/page?delay=${SLOW_MS}`), {
      waitUntil: "commit",
    });
    await page.waitForFunction(() =>
      document.documentElement.hasAttribute("data-lh-mounted"),
    );
    await expect(page.getByTestId("lh-loading")).toBeVisible();
    // The push has reached the browser (its Flight row is in the document);
    // the locked store still shows the document's notes and the boundary is
    // still streaming.
    await page.waitForFunction(
      (note) =>
        (self as unknown as { __lhFlightText: string[] }).__lhFlightText
          .join("")
          .includes(note),
      NOTE,
    );
    await expect(page.getByTestId("lh-slow-value")).toHaveCount(0);

    await page.getByTestId("lh-link-other").click();
    await expect(page.getByTestId("lh-other")).toBeVisible();

    await page.goBack();
    await expect(page).toHaveURL(/\/late-history\/page/);
    await expect(page.getByTestId("lh-note")).toHaveText([NOTE]);
  });
}
