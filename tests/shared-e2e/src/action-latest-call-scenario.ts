import { expect, test, type Page } from "@playwright/test";

/**
 * Hook lock row A3: "If the same action fires several times, the hook
 * reports the latest call" (skills/hooks/handle-and-actions.md). The same
 * action is called twice and the later call returns first.
 *
 * Fixture in each app: /action-latest and /action-latest-vt render
 * ActionLatestCall, an AddToCart reader
 * (`state === "idle" ? result?.name : "Adding…"`, plus a selector for
 * pending). It logs every commit to window.__actionLatestLog. Its slow
 * button calls the action with a 2 s delay, its fast button with 400 ms,
 * and the action returns the name it was given.
 *
 * Variants, one component:
 *  - /action-latest: no transition().
 *  - /action-latest-vt: transition(), so the action's revalidation commits
 *    in a transition with a view transition.
 */

export interface ActionLatestCallScenarioOptions {
  url: (pathname: string) => string;
  waitForHydration: (page: Page) => Promise<void>;
  expectNoPageError: (page: Page) => Disposable;
  expectNoReload: (page: Page) => Promise<AsyncDisposable>;
}

type LogEntry = { shown: string; pending: boolean };
type ProbeWindow = { __actionLatestLog?: LogEntry[] };

const testId = (page: Page, id: string) =>
  page.locator(`[data-testid="${id}"]`);

/** Consecutive duplicates dropped: what the reader shows, frame by frame. */
const distinct = <T>(values: T[]): T[] =>
  values.filter((value, i) => i === 0 || values[i - 1] !== value);

const VARIANTS = [
  { name: "no transition()", path: "/action-latest" },
  { name: "transition()", path: "/action-latest-vt" },
] as const;

export function runActionLatestCallTests(
  options: ActionLatestCallScenarioOptions,
): void {
  for (const variant of VARIANTS) {
    test(`${variant.name}: the later call returning first shows its result, and the earlier call changes nothing`, async ({
      page,
    }) => {
      using _ = options.expectNoPageError(page);
      await page.goto(options.url(variant.path));
      await options.waitForHydration(page);
      await expect(testId(page, "action-latest-shown")).toHaveText("");

      await using __ = await options.expectNoReload(page);
      await page.evaluate(() => {
        (window as unknown as ProbeWindow).__actionLatestLog = [];
      });

      await testId(page, "action-latest-slow").click();
      await expect(testId(page, "action-latest-shown")).toHaveText("Adding…");
      await testId(page, "action-latest-fast").click();

      // Both calls returned, the later one first.
      await expect(testId(page, "action-latest-returned")).toHaveText(
        "second,first",
        { timeout: 10000 },
      );
      // Past the earlier call's 100 ms settle window.
      await page.waitForTimeout(500);

      const log = await page.evaluate(
        () => (window as unknown as ProbeWindow).__actionLatestLog ?? [],
      );
      // Through the full state: the later call's result, then the idle
      // default once its settle window ends. "Adding…" never comes back and
      // the earlier call's result never shows.
      expect(distinct(log.map((entry) => entry.shown))).toEqual([
        "Adding…",
        "second",
        "",
      ]);
      // Through a selector: pending from the first click until the later
      // call returns, once.
      expect(distinct(log.map((entry) => entry.pending))).toEqual([
        true,
        false,
      ]);
    });
  }
}
