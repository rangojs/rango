import { expect, test, type Page } from "@playwright/test";

/**
 * A link to a page the history cache holds sends that page's segment ids, and
 * the server re-renders only what revalidates. The page shows the cached
 * segments plus the response's, and its handles are those segments' pushes
 * plus the response's: the cached page's own, and for a segment taken from
 * the page on screen, that page's. Fixture: history-handles* in each app,
 * Section > A and Section > B layout > B; B's loader reruns on every visit,
 * the section on a navigation to A only and shows its run in its crumb; links
 * do not prefetch. Both apps call this from a dev and a (production) describe.
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

async function readRuns(page: Page, testId: string): Promise<number> {
  const runs = Number(await page.getByTestId(testId).textContent());
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
    const section1 = await readRuns(page, "hch-section-runs");
    await expectPage(page, [`History ${section1}`, "A"], "History handles A");

    // B, first visit: the section is A's, not re-rendered.
    await page.getByTestId("hch-to-b").click();
    await expect(page.getByTestId("hch-b")).toBeVisible();
    const tick1 = await readRuns(page, "hch-b-runs");
    await expect(page.getByTestId("hch-section-runs")).toHaveText(
      String(section1),
    );
    await expectPage(
      page,
      [`History ${section1}`, "B section", "B"],
      "History handles B",
    );

    // A from the history cache: the section re-renders, A's own crumb and
    // title come from its entry.
    await page.getByTestId("hch-to-a").click();
    await expect(page.getByTestId("hch-a")).toBeVisible();
    await expect
      .poll(() => readRuns(page, "hch-section-runs"))
      .toBeGreaterThan(section1);
    const section2 = await readRuns(page, "hch-section-runs");
    await expectPage(page, [`History ${section2}`, "A"], "History handles A");

    // B from the history cache: its loader re-renders, nothing else does. The
    // section is the one on screen, and so is its crumb; B's layout crumb,
    // page crumb and title come from B's entry.
    await page.getByTestId("hch-to-b").click();
    await expect(page.getByTestId("hch-b")).toBeVisible();
    await expect
      .poll(() => readRuns(page, "hch-b-runs"))
      .toBeGreaterThan(tick1);
    await expect(page.getByTestId("hch-section-runs")).toHaveText(
      String(section2),
    );
    await expectPage(
      page,
      [`History ${section2}`, "B section", "B"],
      "History handles B",
    );
  });
}
