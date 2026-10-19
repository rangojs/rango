import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { waitForShellHydration } from "./shell-request.js";

/**
 * A navigation never moves data on screen backwards (dc-t110). A link clicked
 * while an action is in flight takes its copy of the held layout at the click
 * (partial-update.ts cachedSegs); the action answers first and commits its
 * revalidation on the product page; then the navigation commits the layout
 * from that copy. A layout loader without revalidate(), which the action
 * re-ran by default, goes back from the action's run to the one before it.
 * Fixture: action-stale.tsx in each app (as-plain is that loader's run count);
 * both apps call this from a dev and a (production) describe.
 */

export interface ActionHeldSegmentsScenarioOptions {
  url: (pathname: string) => string;
}

interface PlainValue {
  value: string;
  onProduct: boolean;
}

async function useKey(
  page: Page,
  options: ActionHeldSegmentsScenarioOptions,
  key: string,
): Promise<void> {
  await page
    .context()
    .addCookies([{ name: "as-key", value: key, url: options.url("/") }]);
}

// The fixture sets <html data-as-pending> while an action is in flight.
async function waitForSettled(page: Page): Promise<void> {
  await expect(page.locator("html")).not.toHaveAttribute("data-as-pending");
}

// The product page under a fresh key (plain loader run once), after a
// throwaway pass over the action and the slow page, so a dev server answers
// on time.
async function openProductPage(
  page: Page,
  options: ActionHeldSegmentsScenarioOptions,
): Promise<void> {
  await useKey(page, options, `warm-${randomUUID()}`);
  await page.goto(options.url("/action-stale/pdp"));
  await waitForShellHydration(page);
  await page.getByTestId("as-add-fast").click();
  await waitForSettled(page);
  await page.getByTestId("as-to-other-slow").click();
  await expect(page.getByTestId("as-other")).toBeVisible();

  await useKey(page, options, randomUUID());
  await page.goto(options.url("/action-stale/pdp"));
  await waitForShellHydration(page);
  await expect(page.getByTestId("as-plain")).toHaveText("1");
}

export function runActionHeldSegmentsTests(
  options: ActionHeldSegmentsScenarioOptions,
): void {
  test("a navigation that commits after an action's revalidation keeps the action's data in a held layout", async ({
    page,
  }) => {
    // dc-t110: open. The navigation commits the held layout from the copy
    // it took at the click, so this fails until the owner decides the fix.
    test.fail();
    test.setTimeout(60000);
    await openProductPage(page, options);
    // Every value the plain loader shows from here on, and whether the
    // product page was still on screen when it did.
    await page.evaluate(() => {
      const seen: PlainValue[] = [];
      let last = document.querySelector(
        '[data-testid="as-plain"]',
      )?.textContent;
      new MutationObserver(() => {
        const value = document.querySelector(
          '[data-testid="as-plain"]',
        )?.textContent;
        if (value == null || value === last) return;
        last = value;
        seen.push({
          value,
          onProduct: !!document.querySelector('[data-testid="as-pdp"]'),
        });
      }).observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true,
      });
      Object.assign(self, { __asPlainSeen: seen });
    });

    // The action answers once its revalidation reran the 300 ms cart loader,
    // so it commits on the product page before the second page answers
    // (500 ms). Its revalidation re-runs the plain loader by default.
    await page.getByTestId("as-add-fast").click();
    await page.getByTestId("as-to-other-slow").click();
    await expect(page.getByTestId("as-other")).toBeVisible();
    await waitForSettled(page);

    const seen = await page.evaluate(
      () => (self as unknown as { __asPlainSeen: PlainValue[] }).__asPlainSeen,
    );
    expect(seen[0], "the action's run shows on the product page").toEqual({
      value: "2",
      onProduct: true,
    });
    // A later refetch of the page may run the loader again: it never goes
    // back to a run before the action's.
    const runs = seen.map((entry) => Number(entry.value));
    expect(
      runs.filter((run, index) => index > 0 && run < runs[index - 1]!),
      `the navigation keeps the action's run (${runs.join(" -> ")})`,
    ).toEqual([]);
  });
}
