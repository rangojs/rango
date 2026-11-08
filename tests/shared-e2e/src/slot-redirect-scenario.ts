import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { waitForShellHydration } from "./shell-request.js";

/**
 * An item page whose parallel() slot declares loading() and, once the item is
 * deleted, redirects from its async handler: the action that deletes it
 * re-renders the slot, and the browser must navigate to the list the redirect
 * names instead of rendering the Response in the slot. Fixture:
 * slot-redirect.tsx in each app, mounted at /slot-redirect; both apps call
 * this from a dev and a (production) describe.
 */

export interface SlotRedirectScenarioOptions {
  url: (pathname: string) => string;
}

const LIST = "/slot-redirect/list";
const ITEM = "/slot-redirect/item";

export function runSlotRedirectTests(
  options: SlotRedirectScenarioOptions,
): void {
  test("an action from a slot whose handler redirects navigates to the redirect's target", async ({
    page,
    context,
  }) => {
    await context.addCookies([
      { name: "sr-key", value: randomUUID(), url: options.url("/") },
    ]);
    await page.goto(options.url(LIST));
    await waitForShellHydration(page);
    await expect(page.getByTestId("sr-list")).toBeVisible();

    await page.getByTestId("sr-to-item").click();
    await expect(page.getByTestId("sr-side")).toBeVisible();
    await expect(page).toHaveURL(options.url(ITEM));

    await page.getByTestId("sr-delete").click();

    // The slot handler's redirect, followed as a navigation: the list, not
    // the item's URL with a slot that failed to render.
    await expect(page).toHaveURL(options.url(LIST));
    await expect(page.getByTestId("sr-list")).toBeVisible();
    await expect(page.getByTestId("sr-side")).toHaveCount(0);
    await expect(page.getByTestId("sr-item-page")).toHaveCount(0);
  });
}
