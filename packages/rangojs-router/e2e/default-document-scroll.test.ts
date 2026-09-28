import { expect, test, type Page } from "@playwright/test";
import { routerNavigate } from "@shared/e2e";
import type { Fixture } from "./fixture";
import { useFixture } from "./fixture";
import {
  expectNoPageError,
  goBack,
  goForward,
  waitForHydration,
} from "./helper";

/**
 * test-app passes no `document` to createRouter, so it renders the router's
 * DefaultDocument, which includes Html.ScrollRestoration: back/forward restore
 * the scroll position with no app code.
 */

const TEST_APP_ROOT = "./e2e/test-app";

const readScrollY = (page: Page): Promise<number> =>
  page.evaluate(() => Math.round(window.scrollY));

/** Room to scroll on every page: an inline style on <html> survives navigations. */
const makePagesTall = (page: Page): Promise<void> =>
  page.evaluate(() => {
    document.documentElement.style.paddingBottom = "4000px";
  });

function defaultDocumentScrollTests(f: Fixture) {
  test("back and forward restore scroll with no custom document", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/"));
    await waitForHydration(page);
    expect(await page.evaluate(() => window.history.scrollRestoration)).toBe(
      "manual",
    );
    await makePagesTall(page);
    await page.evaluate(() => window.scrollTo(0, 1200));
    await expect.poll(() => readScrollY(page)).toBe(1200);

    await routerNavigate(page, f.url("/blog"));
    await expect.poll(() => readScrollY(page)).toBe(0);

    await goBack(page);
    await expect(page).toHaveURL(f.url("/"));
    await expect.poll(() => readScrollY(page)).toBe(1200);

    await goForward(page);
    await expect(page).toHaveURL(f.url("/blog"));
    await expect.poll(() => readScrollY(page)).toBe(0);
  });
}

test.describe("default-document scroll restoration", () => {
  const f = useFixture({ root: TEST_APP_ROOT, mode: "dev" });
  defaultDocumentScrollTests(f);
});

test.describe("default-document scroll restoration (production)", () => {
  const f = useFixture({ root: TEST_APP_ROOT, mode: "build" });
  defaultDocumentScrollTests(f);
});
