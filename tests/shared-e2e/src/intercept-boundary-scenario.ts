import { randomUUID } from "node:crypto";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { expectConsole } from "./console-guard.js";
import { waitForShellHydration } from "./shell-request.js";

/**
 * An item opened as an intercept over a list, under a layout with a cart
 * count (rango-t215). An intercept is a page in the middle of a navigation:
 * a refresh reloads its URL, so router.refresh() and the refresh another
 * tab's action triggers render the item's full page, as a document load
 * does. Back onto the intercept's entry after an action inside it threw
 * restores the intercept over its page. Fixture: intercept-boundary.tsx in
 * each app, mounted at /intercept-boundary; both apps call this from a dev
 * and a (production) describe.
 */

export interface InterceptBoundaryScenarioOptions {
  url: (pathname: string) => string;
}

const LIST = "/intercept-boundary/list";
const ITEM = "/intercept-boundary/item";

export function runInterceptBoundaryTests(
  options: InterceptBoundaryScenarioOptions,
): void {
  /** The list under a fresh cart (cart 0). */
  async function open(context: BrowserContext, page: Page): Promise<void> {
    await context.addCookies([
      { name: "ib-key", value: randomUUID(), url: options.url("/") },
    ]);
    await show(page);
  }

  async function show(page: Page): Promise<void> {
    await page.goto(options.url(LIST));
    await waitForShellHydration(page);
    await expect(page.getByTestId("ib-list")).toBeVisible();
  }

  /** The item opens as an intercept over the list. */
  async function openItem(page: Page): Promise<void> {
    await page.getByTestId("ib-to-item").click();
    await expect(page.getByTestId("ib-modal")).toBeVisible();
    await expect(page).toHaveURL(options.url(ITEM));
  }

  /** The intercept is still open over the list, not the item's full page. */
  async function expectIntercept(page: Page): Promise<void> {
    await expect(page.getByTestId("ib-modal")).toBeVisible();
    await expect(page.getByTestId("ib-list")).toBeVisible();
    await expect(page.getByTestId("ib-item-page")).toHaveCount(0);
    await expect(page).toHaveURL(options.url(ITEM));
  }

  /** The item's full page at the intercept's URL, as a reload renders it. */
  async function expectFullPage(page: Page): Promise<void> {
    await expect(page.getByTestId("ib-item-page")).toBeVisible();
    await expect(page.getByTestId("ib-modal")).toHaveCount(0);
    await expect(page.getByTestId("ib-list")).toHaveCount(0);
    await expect(page).toHaveURL(options.url(ITEM));
  }

  test("another tab's action refreshes this tab: an open intercept becomes its full page, as on a reload, with the layout's count fresh", async ({
    page,
    context,
  }) => {
    await open(context, page);
    await openItem(page);

    const otherTab = await context.newPage();
    await show(otherTab);
    await otherTab.getByTestId("ib-add").click();
    await expect(otherTab.getByTestId("ib-cart")).toHaveText("cart:1");

    // The action's broadcast refreshes this tab.
    await expect(page.getByTestId("ib-cart")).toHaveText("cart:1");
    await expectFullPage(page);
  });

  test("router.refresh() renders an open intercept's full page, as a reload does", async ({
    page,
    context,
  }) => {
    await open(context, page);
    await openItem(page);

    const refreshed = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        url.pathname.endsWith(ITEM) && url.searchParams.has("_rsc_partial")
      );
    });
    await page.getByTestId("ib-refresh").click();
    await (await refreshed).finished();
    await expectFullPage(page);
  });

  test("Back onto an intercept whose action threw restores it over its page, and shows the write", async ({
    page,
    context,
  }) => {
    expectConsole(page, { allow: [/\[Browser\] Action failed/] });
    await open(context, page);
    await openItem(page);
    await page.getByTestId("ib-fail").click();
    await expect(page.locator("html")).toHaveAttribute(
      "data-ib-result",
      "error",
    );

    await page.getByTestId("ib-to-other").click();
    await expect(page.getByTestId("ib-other")).toBeVisible();
    await page.goBack();
    await expectIntercept(page);
    await expect(page.getByTestId("ib-cart")).toHaveText("cart:1");
  });
}
