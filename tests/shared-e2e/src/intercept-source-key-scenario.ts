import { expect, test, type Page, type Request } from "@playwright/test";
import {
  isMarkedDocument,
  markDocument,
  waitForShellHydration,
} from "./shell-request.js";

/**
 * Back onto an intercept entry the history cache holds restores the intercept
 * over ITS OWN source page. The history cache keys an intercept entry by the
 * intercepted URL and its source page (generateHistoryKey in
 * browser/navigation-store.ts); without the source, two entries for one URL
 * opened from different pages shared a key and the later tree won.
 * Fixture: intercept-held* in each app (the index and /search both link to
 * /handler/1, whose intercept links to /search). Both apps call this from a
 * dev and a (production) describe.
 */

export interface InterceptSourceKeyScenarioOptions {
  url: (pathname: string) => string;
  /** Path of the fixture's index page (the layout's "/" route). */
  basePath: string;
}

export function runInterceptSourceKeyTests(
  options: InterceptSourceKeyScenarioOptions,
): void {
  const interceptedUrl = new RegExp(`${options.basePath}/handler/1$`);
  const searchUrl = new RegExp(`${options.basePath}/search$`);

  async function openFromIndex(page: Page): Promise<void> {
    await page.goto(options.url(options.basePath));
    await waitForShellHydration(page);
    await page.getByTestId("ih-open-handler").click();
    await expect(page.getByTestId("ih-handler-modal")).toBeVisible();
    await expect(page).toHaveURL(interceptedUrl);
    await expect(page.getByTestId("ih-index")).toBeVisible();
  }

  /** E1 index, E2 intercept over index, E3 /search, E4 intercept over /search. */
  async function openFromBothSources(page: Page): Promise<void> {
    await openFromIndex(page);
    await page.getByTestId("ih-handler-intercept-search").click();
    await expect(page).toHaveURL(searchUrl);
    await expect(page.getByTestId("ih-search")).toBeVisible();
    await expect(page.getByTestId("ih-handler-modal")).toHaveCount(0);
    await page.getByTestId("ih-search-open-handler").click();
    await expect(page.getByTestId("ih-handler-modal")).toBeVisible();
    await expect(page).toHaveURL(interceptedUrl);
    await expect(page.getByTestId("ih-search")).toBeVisible();
    await expect(page.getByTestId("ih-index")).toHaveCount(0);
  }

  /** Requests to the intercepted URL made while `run` executes. */
  async function interceptRequestsDuring(
    page: Page,
    run: () => Promise<void>,
  ): Promise<string[]> {
    const seen: string[] = [];
    const onRequest = (req: Request) => {
      if (req.url().includes(`${options.basePath}/handler/1`)) {
        seen.push(`${req.resourceType()} ${req.url()}`);
      }
    };
    page.on("request", onRequest);
    try {
      await run();
    } finally {
      page.off("request", onRequest);
    }
    return seen;
  }

  test("control: Back onto a single-source intercept entry restores the intercept over its source page, and Forward re-opens it, with no fetch", async ({
    page,
  }) => {
    await openFromIndex(page);
    await markDocument(page);

    await page.goBack();
    await expect(page.getByTestId("ih-index")).toBeVisible();
    await expect(page.getByTestId("ih-handler-modal")).toHaveCount(0);

    const requests = await interceptRequestsDuring(page, async () => {
      await page.goForward();
      await expect(page.getByTestId("ih-handler-modal")).toBeVisible();
    });

    await expect(page).toHaveURL(interceptedUrl);
    await expect(page.getByTestId("ih-index")).toBeVisible();
    await expect(page.getByTestId("ih-search")).toHaveCount(0);
    expect(requests).toEqual([]);
    expect(await isMarkedDocument(page)).toBe(true);
  });

  test("control: Back from the second intercept entry lands on its source page without the intercept", async ({
    page,
  }) => {
    await openFromBothSources(page);
    await markDocument(page);

    await page.goBack();

    await expect(page).toHaveURL(searchUrl);
    await expect(page.getByTestId("ih-search")).toBeVisible();
    await expect(page.getByTestId("ih-handler-modal")).toHaveCount(0);
    expect(await isMarkedDocument(page)).toBe(true);
  });

  test("Back onto the first intercept entry (cache hit) restores the intercept over the page it was opened from, not the later source page", async ({
    page,
  }) => {
    await openFromBothSources(page);
    await page.goBack();
    await expect(page.getByTestId("ih-search")).toBeVisible();
    await expect(page.getByTestId("ih-handler-modal")).toHaveCount(0);
    await markDocument(page);

    // E2 is a history-cache hit when this Back issues no request for the
    // intercepted URL; a miss would fetch (or load a document).
    const requests = await interceptRequestsDuring(page, async () => {
      await page.goBack();
      await expect(page.getByTestId("ih-handler-modal")).toBeVisible();
    });
    expect(requests).toEqual([]);
    expect(await isMarkedDocument(page)).toBe(true);

    await expect(page).toHaveURL(interceptedUrl);
    await expect(page.getByTestId("ih-index")).toBeVisible();
    await expect(page.getByTestId("ih-search")).toHaveCount(0);

    // Forward twice: E3 (/search), then E4, which restores the intercept
    // over /search from its own cache entry.
    const forwardRequests = await interceptRequestsDuring(page, async () => {
      await page.goForward();
      await expect(page).toHaveURL(searchUrl);
      await expect(page.getByTestId("ih-search")).toBeVisible();
      await expect(page.getByTestId("ih-handler-modal")).toHaveCount(0);
      await page.goForward();
      await expect(page.getByTestId("ih-handler-modal")).toBeVisible();
    });
    expect(forwardRequests).toEqual([]);
    expect(await isMarkedDocument(page)).toBe(true);
    await expect(page).toHaveURL(interceptedUrl);
    await expect(page.getByTestId("ih-search")).toBeVisible();
    await expect(page.getByTestId("ih-index")).toHaveCount(0);
  });
}
