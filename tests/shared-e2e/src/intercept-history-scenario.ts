import { expect, test, type Page } from "@playwright/test";
import {
  isMarkedDocument,
  markDocument,
  waitForShellHydration,
} from "./shell-request.js";

/**
 * Back/Forward onto an intercept's history entry. Only a client navigation
 * from the source page shows an intercept: a traversal the history cache
 * can restore re-opens it over its source page, and one it must fetch
 * fetches the intercept when the source page is on screen. From any other
 * page (a reload since, or an evicted entry) the entry loads as a document,
 * from the top, which renders the intercepted URL's full page, and the entry
 * stays a full page for later traversals. Fixture: intercept-held* in each
 * app (the handler intercept and its full page link to /away, a page no
 * intercept targets). Both apps call this from a dev and a (production)
 * describe.
 */

export interface InterceptHistoryScenarioOptions {
  url: (pathname: string) => string;
  /** Path of the fixture's index page (the layout's "/" route). */
  basePath: string;
}

// More client navigations than the history cache holds (its `cacheSize`,
// 20 by default): the intercept entry is evicted.
const AWAY_STEPS = 21;

const SCROLLED = 600;

export function runInterceptHistoryTests(
  options: InterceptHistoryScenarioOptions,
): void {
  const interceptedUrl = new RegExp(`${options.basePath}/handler/1$`);

  async function openIntercept(page: Page): Promise<void> {
    await page.goto(options.url(options.basePath));
    await waitForShellHydration(page);
    await page.getByTestId("ih-open-handler").click();
    await expect(page.getByTestId("ih-handler-modal")).toBeVisible();
    await expect(page).toHaveURL(interceptedUrl);
    await expect(page.getByTestId("ih-index")).toBeVisible();
  }

  /** Index, then the intercept over it, then /away?n=1. */
  async function openInterceptThenLeave(page: Page): Promise<void> {
    await openIntercept(page);
    await page.getByTestId("ih-handler-intercept-away").click();
    await expect(page.getByTestId("ih-away-n")).toHaveText("1");
    await expect(page.getByTestId("ih-handler-modal")).toHaveCount(0);
  }

  /** Mark the document and scroll /away down, before the traversal. */
  async function leaveScrolled(page: Page): Promise<void> {
    await page.evaluate((y) => window.scrollTo(0, y), SCROLLED);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(SCROLLED);
    await markDocument(page);
  }

  async function expectFullPage(page: Page): Promise<void> {
    await expect(page).toHaveURL(interceptedUrl);
    await expect(page.getByTestId("ih-handler-page")).toBeVisible();
    await expect(page.getByTestId("ih-handler-modal")).toHaveCount(0);
    await expect(page.getByTestId("ih-index")).toHaveCount(0);
    await expect(page.getByTestId("ih-away")).toHaveCount(0);
  }

  /**
   * The intercepted URL's full page arrived by a document load, at the top,
   * and the entry stays a full page: Back to the index, then Forward
   * restores it in the same document. Were the entry still marked as an
   * intercept, the Forward would load a document again.
   */
  async function expectFullPageEntry(page: Page): Promise<void> {
    await expectFullPage(page);
    expect(await isMarkedDocument(page)).toBe(false);
    await waitForShellHydration(page);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);

    await markDocument(page);
    await page.goBack();
    await expect(page.getByTestId("ih-index")).toBeVisible();
    await expect(page.getByTestId("ih-handler-modal")).toHaveCount(0);
    await page.goForward();
    await expectFullPage(page);
    expect(await isMarkedDocument(page)).toBe(true);
  }

  async function expectInterceptOverIndex(page: Page): Promise<void> {
    await expect(page).toHaveURL(interceptedUrl);
    await expect(page.getByTestId("ih-handler-modal")).toBeVisible();
    await expect(page.getByTestId("ih-index")).toBeVisible();
    await expect(page.getByTestId("ih-handler-page")).toHaveCount(0);
    await expect(page.getByTestId("ih-away")).toHaveCount(0);
    expect(await isMarkedDocument(page)).toBe(true);
  }

  test("Back onto an intercept entry the history cache holds re-opens the intercept over its source page, in the same document", async ({
    page,
  }) => {
    await openInterceptThenLeave(page);
    await markDocument(page);

    await page.goBack();

    await expectInterceptOverIndex(page);
  });

  test("Forward onto an intercept entry from its source page, reloaded since, fetches the intercept over it in the same document", async ({
    page,
  }) => {
    await openIntercept(page);
    await page.goBack();
    await expect(page.getByTestId("ih-handler-modal")).toHaveCount(0);
    await page.reload();
    await waitForShellHydration(page);
    await expect(page.getByTestId("ih-index")).toBeVisible();
    await markDocument(page);

    await page.goForward();

    await expectInterceptOverIndex(page);
  });

  test("a reload on the open intercept renders the full page, and Back onto it from another page restores that page in the same document", async ({
    page,
  }) => {
    await openIntercept(page);
    await page.reload();
    await waitForShellHydration(page);
    await expectFullPage(page);

    await page.getByTestId("ih-handler-page-away").click();
    await expect(page.getByTestId("ih-away-n")).toHaveText("1");
    await markDocument(page);
    await page.goBack();

    await expectFullPage(page);
    expect(await isMarkedDocument(page)).toBe(true);
  });

  test("a reload, then Back onto an intercept entry loads the intercepted URL's full page as a document, from the top, and it stays one", async ({
    page,
  }) => {
    await openInterceptThenLeave(page);
    await page.reload();
    await waitForShellHydration(page);
    await expect(page.getByTestId("ih-away-n")).toHaveText("1");
    await leaveScrolled(page);

    await page.goBack();

    await expectFullPageEntry(page);
  });

  test("a traversal onto an intercept entry the history cache evicted loads the intercepted URL's full page as a document, from the top, and it stays one", async ({
    page,
  }) => {
    await openInterceptThenLeave(page);
    for (let n = 2; n <= AWAY_STEPS; n++) {
      await page.getByTestId("ih-away-next").click();
      await expect(page.getByTestId("ih-away-n")).toHaveText(String(n));
    }
    await leaveScrolled(page);

    // One traversal straight to the intercept entry, as the browser's
    // back-button history menu does.
    await page.evaluate((steps) => history.go(-steps), AWAY_STEPS);

    await expectFullPageEntry(page);
  });
}
