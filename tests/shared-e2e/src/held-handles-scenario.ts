import { expect, test, type Page } from "@playwright/test";

/**
 * A loader whose rerun an action skips keeps the handle pushes of the run
 * whose data the page still shows; a loader that reruns replaces its own
 * (#1103). Two loaders on one route push into the same segment's buckets: the
 * held one a Meta title and a crumb, the rerun one a crumb. An unrelated
 * action skips the held loader (its revalidate() answers false) and reruns the
 * other; the target action reruns both. Fixture: held-handles* in each app,
 * a clientUrls() group and its urls() twin, whose route handler also pushes a
 * crumb and reruns on every action. Both apps call this from a dev and a
 * (production) describe.
 */

export interface HeldHandlesScenarioOptions {
  url: (pathname: string) => string;
  /** Path of the clientUrls() group's route. */
  clientPath: string;
  /** Path of the urls() twin. */
  serverPath: string;
}

async function readRuns(page: Page, testId: string): Promise<number> {
  const text = await page.getByTestId(testId).textContent();
  const runs = Number(text);
  expect(Number.isInteger(runs) && runs > 0).toBe(true);
  return runs;
}

async function expectCrumbs(page: Page, expected: string[]): Promise<void> {
  await expect
    .poll(async () =>
      (await page.getByTestId("hh-crumb").allTextContents()).sort(),
    )
    .toEqual([...expected].sort());
}

async function runsAfter(
  page: Page,
  testId: string,
  previous: number,
): Promise<number> {
  await expect(page.getByTestId(testId)).not.toHaveText(String(previous));
  return readRuns(page, testId);
}

export function runHeldHandlesTests(options: HeldHandlesScenarioOptions): void {
  const variants = [
    { name: "clientUrls() group", path: options.clientPath, handler: [] },
    { name: "urls() route", path: options.serverPath, handler: ["handler"] },
  ];

  for (const variant of variants) {
    test(`${variant.name}: a loader an action skips keeps its title and crumb`, async ({
      page,
    }) => {
      await page.goto(options.url(variant.path));
      await expect(page.getByTestId("hh-view")).toBeVisible();
      await page.waitForFunction(() =>
        document.documentElement.hasAttribute("data-hydrated"),
      );

      const held = await readRuns(page, "hh-held-runs");
      const rerun = await readRuns(page, "hh-rerun-runs");
      await expect(page).toHaveTitle(`Held handles ${held}`);
      await expectCrumbs(page, [
        `held:${held}`,
        `rerun:${rerun}`,
        ...variant.handler,
      ]);

      // Unrelated action: the held loader keeps its data and its pushes, the
      // rerun loader's crumb is replaced, not added to.
      await page.getByTestId("hh-toggle").click();
      const rerunAfterToggle = await runsAfter(page, "hh-rerun-runs", rerun);
      await expect(page.getByTestId("hh-held-runs")).toHaveText(String(held));
      await expect.soft(page).toHaveTitle(`Held handles ${held}`);
      await expectCrumbs(page, [
        `held:${held}`,
        `rerun:${rerunAfterToggle}`,
        ...variant.handler,
      ]);

      // The target action reruns the held loader: its new pushes replace the
      // old ones.
      await page.getByTestId("hh-target").click();
      const heldAfterTarget = await runsAfter(page, "hh-held-runs", held);
      const rerunAfterTarget = await runsAfter(
        page,
        "hh-rerun-runs",
        rerunAfterToggle,
      );
      await expectCrumbs(page, [
        `held:${heldAfterTarget}`,
        `rerun:${rerunAfterTarget}`,
        ...variant.handler,
      ]);
      await expect(page).toHaveTitle(`Held handles ${heldAfterTarget}`);
    });
  }
}
