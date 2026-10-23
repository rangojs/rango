import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { useKey, waitForSettled } from "./action-stale-fixture.js";
import { waitForShellHydration } from "./shell-request.js";

/**
 * A navigation that commits after an action landed keeps the copy of the held
 * layout it took at the click (partial-update.ts cachedSegs), from before the
 * land; the follow-up the land owes, because the navigation was in flight
 * (server-action-bridge.ts followUp), brings the action's data back one round
 * trip later. A layout loader without revalidate(), which the action re-ran
 * by default, shows the action's run on the product page, the click's copy
 * on the new page, then the follow-up's run. Fixture: action-stale.tsx in
 * each app (as-plain is that loader's run count); both apps call this from a
 * dev and a (production) describe.
 */

export interface ActionHeldSegmentsScenarioOptions {
  url: (pathname: string) => string;
}

interface PlainValue {
  value: string;
  onProduct: boolean;
}

// The product page under a fresh key (plain loader run once), after a
// throwaway pass over the action and the slow page, so a dev server answers
// on time.
async function openWarmedProductPage(
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
  test("a navigation that commits after an action's land shows the action's data in a held layout once the follow-up lands", async ({
    page,
  }) => {
    test.setTimeout(60000);
    await openWarmedProductPage(page, options);
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

    // The navigation's click copy of the held layout predates the land: the
    // follow-up after its commit re-runs the loader.
    await expect(page.getByTestId("as-plain")).toHaveText("3");
    const seen = await page.evaluate(
      () => (self as unknown as { __asPlainSeen: PlainValue[] }).__asPlainSeen,
    );
    test.info().annotations.push({
      type: "plain",
      description: seen.map((entry) => entry.value).join(" -> "),
    });
    expect(seen[0], "the action's run shows on the product page").toEqual({
      value: "2",
      onProduct: true,
    });
  });
}
