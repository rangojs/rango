import { randomUUID } from "node:crypto";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { expectConsole } from "./console-guard.js";
import { waitForShellHydration } from "./shell-request.js";

/**
 * An action that writes, then throws, on a route with its own errorBoundary()
 * under a layout whose loader reads the write (a cart count). The user stays
 * on the page. The server answers with the error-boundary response: the
 * boundary's segment alone (match-api.ts matchError), so the browser keeps
 * the layout's cached loader data (segment-reconciler.ts
 * reconcileErrorSegments). Other tabs refresh and a fresh load reads the
 * write; the page the action ran on keeps the count from before it, also
 * after Back to it (rango-t124). A successful action on the same page shows
 * its write in the layout. Fixture: action-boundary.tsx in each app, mounted
 * at /action-boundary; both apps call this from a dev and a (production)
 * describe.
 */

export interface ActionBoundaryScenarioOptions {
  url: (pathname: string) => string;
}

const PAGE = "/action-boundary/page";

export function runActionBoundaryTests(
  options: ActionBoundaryScenarioOptions,
): void {
  /** The page under a fresh cart (cart 0). */
  async function open(context: BrowserContext, page: Page): Promise<void> {
    await context.addCookies([
      { name: "ab-key", value: randomUUID(), url: options.url("/") },
    ]);
    await show(page);
  }

  async function show(page: Page): Promise<void> {
    await page.goto(options.url(PAGE));
    await waitForShellHydration(page);
    await expect(page.getByTestId("ab-page")).toBeVisible();
  }

  /** The action writes, then throws; the call's rejection is caught. */
  async function addThenFail(page: Page): Promise<void> {
    await page.getByTestId("ab-fail").click();
    await expect(page.locator("html")).toHaveAttribute(
      "data-ab-result",
      "error",
    );
    await expect(page.getByTestId("ab-boundary")).toBeVisible();
    await expect(page.getByTestId("ab-page")).toHaveCount(0);
  }

  test("a successful action shows its write in the layout's count", async ({
    page,
    context,
  }) => {
    await open(context, page);
    await expect(page.getByTestId("ab-cart")).toHaveText("cart:0");

    await page.getByTestId("ab-add").click();
    await expect(page.locator("html")).toHaveAttribute("data-ab-result", "1");
    await expect(page.getByTestId("ab-cart")).toHaveText("cart:1");
  });

  test("an action that throws under its route's errorBoundary() shows the boundary, and the layout's count above it shows the write", async ({
    page,
    context,
  }) => {
    expectConsole(page, { allow: [/\[Browser\] Action failed/] });
    await open(context, page);
    await expect(page.getByTestId("ab-cart")).toHaveText("cart:0");
    const otherTab = await context.newPage();
    await show(otherTab);
    await expect(otherTab.getByTestId("ab-cart")).toHaveText("cart:0");

    await addThenFail(page);
    // The write reached the server: the other tab refreshes on the
    // action's broadcast, and a fresh load reads it.
    await expect(otherTab.getByTestId("ab-cart")).toHaveText("cart:1");
    const fresh = await context.newPage();
    await show(fresh);
    await expect(fresh.getByTestId("ab-cart")).toHaveText("cart:1");

    // rango-t124: the layout keeps the count from before the write.
    test.fail();
    await expect(page.getByTestId("ab-cart")).toHaveText("cart:1");
  });

  test("Back to a page whose action threw under its route's errorBoundary() shows the write in the layout's count", async ({
    page,
    context,
  }) => {
    expectConsole(page, { allow: [/\[Browser\] Action failed/] });
    await open(context, page);
    await addThenFail(page);

    // The action marked the page's entry stale: Back revalidates it.
    await page.getByTestId("ab-to-other").click();
    await expect(page.getByTestId("ab-other")).toBeVisible();
    const revalidated = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        url.pathname.endsWith(PAGE) &&
        url.searchParams.get("_rsc_stale") === "true"
      );
    });
    await page.goBack();
    await expect(page).toHaveURL(options.url(PAGE));
    await (await revalidated).finished();

    // rango-t124: Back shows the count from before the write.
    test.fail();
    await expect(page.getByTestId("ab-cart")).toHaveText("cart:1");
  });
}
