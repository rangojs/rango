import { expect, test, type Page } from "@playwright/test";
import { waitForShellHydration } from "./shell-request.js";

/**
 * The page under an intercept stays on screen when the browser asks for the
 * intercepted URL holding no segments: the server answers with the layouts
 * and the slot only, and the browser keeps the page the answer lands over
 * (browser/intercept-utils.ts wholeInterceptMatched). Senders pinned here: a
 * followed redirect (an action's, a navigation's) and a Back/Forward
 * revalidation with handles pending. Fixture: intercept-held* in each app.
 * Userland pin: src/testing/__tests__/serve-shell-request-intercept-whole-request.rsc-test.tsx.
 */

export interface InterceptWholeRequestScenarioOptions {
  url: (pathname: string) => string;
  /** Path of the fixture's index page (the layout's "/" route). */
  basePath: string;
}

export function runInterceptWholeRequestTests(
  options: InterceptWholeRequestScenarioOptions,
): void {
  async function gotoIndex(page: Page): Promise<void> {
    await page.goto(options.url(options.basePath));
    await waitForShellHydration(page);
    await expect(page.getByTestId("ih-index")).toBeVisible();
  }

  /** The crumbs the layout shows with useHandle, by exact text. */
  const crumb = (page: Page, text: string) =>
    page.getByTestId("ih-crumb").filter({ hasText: new RegExp(`^${text}$`) });

  test("control: a link to the intercepted route opens the intercept over the page", async ({
    page,
  }) => {
    await gotoIndex(page);
    await expect(crumb(page, "index")).toHaveCount(1);

    await page.getByTestId("ih-open-handler").click();

    await expect(page).toHaveURL(/\/intercept-held\/handler\/1$/);
    await expect(page.getByTestId("ih-handler-modal")).toBeVisible();
    await expect(page.getByTestId("ih-index")).toBeVisible();
    await expect(crumb(page, "index")).toHaveCount(1);
  });

  test("a server action that redirects to an intercepted route opens the intercept over the page", async ({
    page,
  }) => {
    await gotoIndex(page);
    await expect(crumb(page, "index")).toHaveCount(1);
    const writes = page.getByTestId("ih-index-writes");
    const before = await writes.innerText();

    await page.getByTestId("ih-redirect-to-intercept").click();

    await expect(page).toHaveURL(/\/intercept-held\/handler\/1$/);
    await expect(page.getByTestId("ih-handler-modal")).toBeVisible();
    await expect(crumb(page, "modal-handler:1")).toHaveCount(1);
    // The page under the intercept: its tree, its handle push, and its render
    // from before the action.
    await expect(page.getByTestId("ih-index")).toBeVisible();
    await expect(crumb(page, "index")).toHaveCount(1);
    await expect(writes).toHaveText(before);

    // Once the intercept closes, the page renders again, with the action's
    // write.
    await page.getByTestId("ih-handler-intercept-to-index").click();
    await expect(page).toHaveURL(/\/intercept-held$/);
    await expect(page.getByTestId("ih-handler-modal")).toHaveCount(0);
    await expect(writes).not.toHaveText(before);
  });

  test("a link to a route that redirects to an intercepted route opens the intercept over the page", async ({
    page,
  }) => {
    await gotoIndex(page);
    await expect(crumb(page, "index")).toHaveCount(1);

    await page.getByTestId("ih-link-redirect").click();

    await expect(page).toHaveURL(/\/intercept-held\/handler\/1$/);
    await expect(page.getByTestId("ih-handler-modal")).toBeVisible();
    await expect(page.getByTestId("ih-index")).toBeVisible();
    await expect(crumb(page, "index")).toHaveCount(1);
  });

  test("Back and Forward over an intercept left before its deferred handle landed keep the page under it", async ({
    page,
  }) => {
    await gotoIndex(page);

    await page.getByTestId("ih-open-deferred").click();
    await expect(page.getByTestId("ih-deferred-intercept")).toBeVisible();
    // Left before the crumb resolves (DEFERRED_PUSH_MS in the fixture).
    await expect(crumb(page, "deferred:1")).toHaveCount(0);
    await page.goBack();
    await expect(page.getByTestId("ih-deferred-intercept")).toHaveCount(0);
    await expect(page.getByTestId("ih-index")).toBeVisible();

    // The revalidation of an entry whose handles were pending holds nothing.
    const revalidated = page.waitForRequest((request) => {
      const url = new URL(request.url());
      return (
        url.pathname.endsWith("/intercept-held/deferred/1") &&
        url.searchParams.get("_rsc_segments") === ""
      );
    });
    await page.goForward();
    await expect(page.getByTestId("ih-deferred-intercept")).toBeVisible();
    await revalidated;

    // The revalidation's deferred crumb lands after its commit: the commit is
    // on screen.
    await expect(crumb(page, "deferred:1")).toHaveCount(1, {
      timeout: 10_000,
    });
    await expect(page.getByTestId("ih-deferred-intercept")).toBeVisible();
    await expect(page.getByTestId("ih-index")).toBeVisible();
    await expect(crumb(page, "index")).toHaveCount(1);
  });
}
