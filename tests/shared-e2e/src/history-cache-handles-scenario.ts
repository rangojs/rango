import { expect, test, type Page } from "@playwright/test";

/**
 * A link to a page the history cache holds sends that page's segment ids, and
 * the server re-renders only what revalidates. The page shows the cached
 * segments plus the response's, so its handles are the cached segments'
 * pushes plus the response's. Before, a response that re-rendered anything
 * merged onto the handles of the page being left: the second visit to B lost
 * B's layout crumb, its page crumb and its title. Fixture: history-handles*
 * in each app, Section > A and Section > B layout > B, B's loader rerunning
 * on every visit; links do not prefetch. Both apps call this from a dev and a
 * (production) describe.
 */

export interface HistoryCacheHandlesScenarioOptions {
  url: (pathname: string) => string;
}

async function expectPage(
  page: Page,
  crumbs: string[],
  title: string,
): Promise<void> {
  await expect(page.getByTestId("hch-crumb")).toHaveText(crumbs);
  await expect(page).toHaveTitle(title);
}

async function readRuns(page: Page): Promise<number> {
  const runs = Number(await page.getByTestId("hch-b-runs").textContent());
  expect(Number.isInteger(runs) && runs > 0).toBe(true);
  return runs;
}

export function runHistoryCacheHandlesTests(
  options: HistoryCacheHandlesScenarioOptions,
): void {
  test("a link back to a cached page whose loader reruns keeps its layout crumb, page crumb and title", async ({
    page,
  }) => {
    await page.goto(options.url("/history-handles/a"));
    await expect(page.getByTestId("hch-a")).toBeVisible();
    await page.waitForFunction(() =>
      document.documentElement.hasAttribute("data-hydrated"),
    );
    await expectPage(page, ["History", "A"], "History handles A");

    await page.getByTestId("hch-to-b").click();
    await expect(page.getByTestId("hch-b")).toBeVisible();
    const firstRuns = await readRuns(page);
    await expectPage(page, ["History", "B section", "B"], "History handles B");

    // A from the history cache: nothing of it re-renders.
    await page.getByTestId("hch-to-a").click();
    await expect(page.getByTestId("hch-a")).toBeVisible();
    await expectPage(page, ["History", "A"], "History handles A");

    // B from the history cache: its loader re-renders, nothing else does.
    await page.getByTestId("hch-to-b").click();
    await expect(page.getByTestId("hch-b")).toBeVisible();
    await expect.poll(() => readRuns(page)).toBeGreaterThan(firstRuns);
    await expectPage(page, ["History", "B section", "B"], "History handles B");
  });
}
