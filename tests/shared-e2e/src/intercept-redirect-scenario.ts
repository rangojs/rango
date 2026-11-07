import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { waitForShellHydration } from "./shell-request.js";

/**
 * An item opened as an intercept over a list. The intercept's handler declares
 * loading() and, once the item is deleted, redirects from its async handler:
 * the action that deletes it re-renders the slot, and the browser must navigate
 * to the list the redirect names instead of rendering the Response into the
 * modal. Fixture: intercept-redirect.tsx in each app, mounted at
 * /intercept-redirect; both apps call this from a dev and a (production)
 * describe.
 */

export interface InterceptRedirectScenarioOptions {
  url: (pathname: string) => string;
}

const LIST = "/intercept-redirect/list";
const ITEM = "/intercept-redirect/item";

export function runInterceptRedirectTests(
  options: InterceptRedirectScenarioOptions,
): void {
  test("an action from an open intercept whose handler redirects navigates to the redirect's target", async ({
    page,
    context,
  }) => {
    await context.addCookies([
      { name: "ir-key", value: randomUUID(), url: options.url("/") },
    ]);
    await page.goto(options.url(LIST));
    await waitForShellHydration(page);
    await expect(page.getByTestId("ir-list")).toBeVisible();

    await page.getByTestId("ir-to-item").click();
    await expect(page.getByTestId("ir-modal")).toBeVisible();
    await expect(page.getByTestId("ir-list")).toBeVisible();
    await expect(page).toHaveURL(options.url(ITEM));

    await page.getByTestId("ir-delete").click();

    // The intercept handler's redirect, followed as a navigation: the list,
    // not the item's URL with a modal that failed to render.
    await expect(page).toHaveURL(options.url(LIST));
    await expect(page.getByTestId("ir-list")).toBeVisible();
    await expect(page.getByTestId("ir-modal")).toHaveCount(0);
    await expect(page.getByTestId("ir-item-page")).toHaveCount(0);
  });
}
