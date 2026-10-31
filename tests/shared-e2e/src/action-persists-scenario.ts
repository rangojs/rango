import { expect, test, type Page } from "@playwright/test";
import { expectConsole } from "./console-guard.js";

/**
 * useAction() keeps a settled call's result and error until the action's
 * next call (rango-t223, owner decision rango-t219-q3): well past the settle,
 * through a navigation and a Back, and in a reader that mounts after it. The
 * next call reads loading with no result.
 *
 * Fixture in each app: /action-persists/:id and /action-persists-vt/:id,
 * pages a and b under a layout whose chrome (action-persists-chrome) reads
 * the save through the full state and a selector for its error, beside
 * useNavigation() and usePathname(), and logs every commit to
 * window.__actionPersistsLog. Each page mounts a reader by export name
 * (action-persists-page-reader). Every request waits 300 ms; the save
 * answers 300 ms later with "saved <n>" (its nth call), or throws, and the
 * page's errorBoundary() shows under the layout.
 *
 * Variants, one fixture:
 *  - /action-persists/:id: no transition().
 *  - /action-persists-vt/:id: transition(), so navigations and the action's
 *    revalidation commit in a transition with a view transition.
 */

export interface ActionPersistsScenarioOptions {
  url: (pathname: string) => string;
  waitForHydration: (page: Page) => Promise<void>;
  expectNoPageError: (page: Page) => Disposable;
  expectNoReload: (page: Page) => Promise<AsyncDisposable>;
}

type LogEntry = {
  state: string;
  result: string;
  error: string;
  pathname: string;
};
type ProbeWindow = { __actionPersistsLog?: LogEntry[] };

const testId = (page: Page, id: string) =>
  page.locator(`[data-testid="${id}"]`);

/** Well past the controller's 100 ms cleanup of a settled call. */
const PAST_SETTLE = 1000;

/** Consecutive duplicates dropped: what the reader shows, frame by frame. */
const distinct = <T>(values: T[]): T[] =>
  values.filter((value, i) => i === 0 || values[i - 1] !== value);

/**
 * The chrome's action state, commit by commit since open() cleared the log:
 * loading and streaming read as busy.
 */
async function shownFrom(page: Page): Promise<string[]> {
  const log = await page.evaluate(
    () => (window as unknown as ProbeWindow).__actionPersistsLog ?? [],
  );
  return distinct(
    log.map(
      (entry) =>
        `${entry.state === "idle" ? "idle" : "busy"} ${entry.result} ${entry.error}`,
    ),
  );
}

const VARIANTS = [
  { name: "no transition()", base: "/action-persists" },
  { name: "transition()", base: "/action-persists-vt" },
] as const;

export function runActionPersistsTests(
  options: ActionPersistsScenarioOptions,
): void {
  async function open(page: Page, base: string): Promise<void> {
    await page.goto(options.url(`${base}/a`));
    await options.waitForHydration(page);
    await expect(testId(page, "action-persists-chrome")).toHaveAttribute(
      "data-result",
      "-",
    );
    await page.evaluate(() => {
      (window as unknown as ProbeWindow).__actionPersistsLog = [];
    });
  }

  for (const variant of VARIANTS) {
    test(`${variant.name}: a call's result stays past its settle, through a navigation and a Back, until the next call`, async ({
      page,
    }) => {
      using _ = options.expectNoPageError(page);
      await open(page, variant.base);
      await using __ = await options.expectNoReload(page);
      const chrome = testId(page, "action-persists-chrome");
      const reader = testId(page, "action-persists-page-reader");

      await testId(page, "action-persists-save").click();
      await expect(chrome).toHaveAttribute("data-result", "saved 1", {
        timeout: 10000,
      });
      await page.waitForTimeout(PAST_SETTLE);
      await expect(chrome).toHaveAttribute("data-state", "idle");
      await expect(chrome).toHaveAttribute("data-result", "saved 1");
      await expect(reader).toHaveAttribute("data-result", "saved 1");

      // Page b's reader mounts after the settle and reads the call; the
      // layout's reader keeps it through the navigation and the Back.
      await testId(page, "action-persists-to-b").click();
      await expect(reader).toHaveAttribute("data-page", "b");
      await expect(reader).toHaveAttribute("data-result", "saved 1");
      await page.goBack();
      await expect(reader).toHaveAttribute("data-page", "a");
      await expect(reader).toHaveAttribute("data-result", "saved 1");
      await expect(chrome).toHaveAttribute("data-result", "saved 1");

      // The next call reads loading with no result, then its own.
      await testId(page, "action-persists-save").click();
      await expect(chrome).toHaveAttribute("data-result", "saved 2", {
        timeout: 10000,
      });
      await page.waitForTimeout(PAST_SETTLE);
      await expect(chrome).toHaveAttribute("data-result", "saved 2");
      await expect(reader).toHaveAttribute("data-result", "saved 2");

      expect(await shownFrom(page)).toEqual([
        "busy - -",
        "idle saved 1 -",
        "busy - -",
        "idle saved 2 -",
      ]);
    });

    test(`${variant.name}: a call that fails keeps its error past its settle, through a navigation and a Back, until the next call`, async ({
      page,
    }) => {
      expectConsole(page, { allow: [/\[Browser\] Action failed/] });
      using _ = options.expectNoPageError(page);
      await open(page, variant.base);
      await using __ = await options.expectNoReload(page);
      const chrome = testId(page, "action-persists-chrome");
      const reader = testId(page, "action-persists-page-reader");

      await testId(page, "action-persists-fail").click();
      await expect(testId(page, "action-persists-boundary")).toBeVisible({
        timeout: 10000,
      });
      await expect(chrome).toHaveAttribute("data-error", "error");
      await page.waitForTimeout(PAST_SETTLE);
      await expect(chrome).toHaveAttribute("data-state", "idle");
      await expect(chrome).toHaveAttribute("data-error", "error");
      await expect(chrome).toHaveAttribute("data-result", "-");

      // Page b's reader mounts after the settle and reads the error.
      await testId(page, "action-persists-to-b").click();
      await expect(reader).toHaveAttribute("data-page", "b");
      await expect(reader).toHaveAttribute("data-error", "error");
      await expect(chrome).toHaveAttribute("data-error", "error");
      await page.goBack();
      await expect(testId(page, "action-persists-boundary")).toBeVisible();
      await expect(chrome).toHaveAttribute("data-error", "error");

      // The next call, from page b, clears the error: loading, then its
      // result.
      await testId(page, "action-persists-to-b").click();
      await expect(reader).toHaveAttribute("data-page", "b");
      await testId(page, "action-persists-save").click();
      await expect(chrome).toHaveAttribute("data-result", "saved 2", {
        timeout: 10000,
      });
      await expect(chrome).toHaveAttribute("data-error", "-");
      await expect(reader).toHaveAttribute("data-error", "-");

      expect(await shownFrom(page)).toEqual([
        "busy - -",
        "idle - error",
        "busy - -",
        "idle saved 2 -",
      ]);
    });
  }
}
