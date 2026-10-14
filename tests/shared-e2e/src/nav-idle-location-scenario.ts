import { expect, test, type Page } from "@playwright/test";
import {
  countViewTransitions,
  viewTransitions,
} from "./view-transition-probe.js";

/**
 * #1164: on a same-route search navigation, useNavigation() reaches idle in
 * the commit that brings useSearchParams() the new search, never earlier.
 *
 * Fixture in each app: /nav-idle and /nav-idle-vt render NavIdleFilters, the
 * issue's filter chips, which log every commit's (idle through a selector,
 * idle through the full state, committed search, chips shown) to
 * window.__navIdleLog. The page's loader reads the search and takes 400 ms,
 * so the navigation commits before its data arrives and React holds that
 * commit.
 *
 * Variants, one page:
 *  - /nav-idle: no transition(), the same-structure hold.
 *  - /nav-idle-vt: transition(), the browser's view transition, counted.
 *  - /nav-idle-vt without view transitions: an init script deletes
 *    Document.prototype.startViewTransition, so React commits the transition
 *    without one, as in a browser that has none.
 */

export interface NavIdleLocationScenarioOptions {
  url: (pathname: string) => string;
  waitForHydration: (page: Page) => Promise<void>;
  expectNoPageError: (page: Page) => Disposable;
  expectNoReload: (page: Page) => Promise<AsyncDisposable>;
}

type LogEntry = {
  idle: boolean;
  fullIdle: boolean;
  search: string;
  shown: string;
};
type ProbeWindow = { __navIdleLog?: LogEntry[] };

const testId = (page: Page, id: string) =>
  page.locator(`[data-testid="${id}"]`);

const VARIANTS = [
  { name: "no transition()", path: "/nav-idle", vt: "none" },
  {
    name: "transition() with a view transition",
    path: "/nav-idle-vt",
    vt: "supported",
  },
  {
    name: "transition() where view transitions are unsupported",
    path: "/nav-idle-vt",
    vt: "unsupported",
  },
] as const;

export function runNavIdleLocationTests(
  options: NavIdleLocationScenarioOptions,
): void {
  for (const variant of VARIANTS) {
    test(`${variant.name}: removing a chip never commits idle with the old search`, async ({
      page,
    }) => {
      using _ = options.expectNoPageError(page);
      if (variant.vt === "unsupported") {
        await page.addInitScript(() => {
          delete (Document.prototype as { startViewTransition?: unknown })
            .startViewTransition;
        });
      }
      await countViewTransitions(page);

      await page.goto(options.url(`${variant.path}?tag=a&tag=b`));
      await options.waitForHydration(page);
      await expect(testId(page, "nav-idle-server-tags")).toHaveText("a,b");
      expect(await page.evaluate(() => "startViewTransition" in document)).toBe(
        variant.vt !== "unsupported",
      );

      await using __ = await options.expectNoReload(page);
      await page.evaluate(() => {
        (window as unknown as ProbeWindow).__navIdleLog = [];
      });
      await testId(page, "nav-idle-remove-a").click();

      await expect(testId(page, "nav-idle-server-tags")).toHaveText("b");
      await expect
        .poll(() =>
          page.evaluate(() => {
            const log = (window as unknown as ProbeWindow).__navIdleLog ?? [];
            return log[log.length - 1];
          }),
        )
        .toEqual({ idle: true, fullIdle: true, search: "tag=b", shown: "b" });

      const log = await page.evaluate(
        () => (window as unknown as ProbeWindow).__navIdleLog ?? [],
      );
      // The chips the click asked for stay on screen throughout.
      expect(log.map((entry) => entry.shown)).toEqual(log.map(() => "b"));
      // From the commit that reports the navigation on: loading on the page
      // being left, then idle with the new search, in one commit. Through
      // a selector and through the full state.
      for (const read of ["idle", "fullIdle"] as const) {
        const fromLoading = log
          .slice(log.findIndex((entry) => !entry[read]))
          .map((entry) => `${entry[read] ? "idle" : "loading"} ${entry.search}`)
          .filter((entry, i, all) => all[i - 1] !== entry);
        expect(fromLoading, read).toEqual([
          "loading tag=a&tag=b",
          "idle tag=b",
        ]);
      }

      if (variant.vt === "supported") {
        expect(await viewTransitions(page)).toBeGreaterThan(0);
      }
    });
  }
}
