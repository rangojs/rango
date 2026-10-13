import { expect, type Page } from "@playwright/test";
import { readProbe, watchFlash } from "./flash-probe.js";

/**
 * A clientUrls() group whose layout and page components carry their own items
 * (`Component.use`, in a module apart from the group), behind a 400 ms server
 * middleware. The page's `.use` declares a stats loader whose revalidate()
 * predicate re-runs it only for its own action, an item loader and a
 * loading() skeleton; the layout's `.use` a loader on the default rules.
 * Fixture: client-urls-component-use* in each app.
 */
export interface ClientUrlsComponentUseOptions {
  url: (pathname: string) => string;
  /** The group's include() mount. */
  path: string;
}

async function markKept(page: Page, ...ids: string[]): Promise<void> {
  for (const id of ids) {
    await page
      .getByTestId(id)
      .evaluate((el) => el.setAttribute("data-e2e-kept", "1"));
  }
}

async function expectKept(page: Page, ...ids: string[]): Promise<void> {
  for (const id of ids) {
    await expect(page.getByTestId(id)).toHaveAttribute("data-e2e-kept", "1");
  }
}

/**
 * The components' own items drive the route: their loaders' data renders on
 * a document request, the page's loading() shows on a cold navigation, and
 * its revalidate() predicate holds the stats loader on navigations and on
 * another action while its own action re-runs it. The layout and the page
 * keep their instances across a route switch, a param navigation, actions
 * and Back.
 */
export async function expectComponentUseItemsDriveTheRoute(
  page: Page,
  options: ClientUrlsComponentUseOptions,
): Promise<void> {
  const stats = page.getByTestId("ccu-stats");
  const shell = page.getByTestId("ccu-shell");

  // Document request: both components' loaders render in the document.
  await page.goto(options.url(`${options.path}/items/alpha`));
  await expect(page.getByTestId("ccu-item-data")).toHaveText("item:alpha");
  await expect(stats).toHaveText(/^stats:\d+$/);
  await expect(shell).toHaveText(/^shell:\d+$/);

  // Cold navigation from the index: the page's loading() shows, then data.
  await page.goto(options.url(options.path));
  await expect(page.getByTestId("ccu-index")).toBeVisible();
  await page.waitForFunction(() =>
    document.documentElement.hasAttribute("data-hydrated"),
  );
  await markKept(page, "ccu-layout");
  await watchFlash(page, "ccu-skeleton", ["ccu-layout"]);
  await page.getByTestId("ccu-to-alpha").click();
  await expect(page.getByTestId("ccu-item-data")).toHaveText("item:alpha");
  await expect(stats).toHaveText(/^stats:\d+$/);
  let probe = await readProbe(page);
  expect(probe.installed, "no document reload").toBe(true);
  expect(probe.flash, "the page's loading() showed on the cold click").toBe(
    true,
  );
  expect(probe.detached, "the layout never left the DOM").toBe(false);
  await expectKept(page, "ccu-layout");
  await markKept(page, "ccu-item");
  const held = (await stats.textContent()) ?? "";

  // A param navigation: the predicate holds the stats loader.
  await page.getByTestId("ccu-to-beta").click();
  await expect(page.getByTestId("ccu-item-data")).toHaveText("item:beta");
  await expect(stats).toHaveText(held);
  await expectKept(page, "ccu-layout", "ccu-item");

  // Another action: the layout's loader re-runs on the default rules; the
  // predicate holds the stats loader. No skeleton, no remount.
  await watchFlash(page, "ccu-skeleton", ["ccu-layout", "ccu-item"]);
  const shellBefore = (await shell.textContent()) ?? "";
  await page.getByTestId("ccu-other").click();
  await expect(shell).not.toHaveText(shellBefore);
  await expect(stats).toHaveText(held);

  // Its own action re-runs it.
  await page.getByTestId("ccu-bump").click();
  await expect(stats).not.toHaveText(held);
  probe = await readProbe(page);
  expect(probe.installed, "no document reload").toBe(true);
  expect(probe.flash, "no skeleton during the actions").toBe(false);
  expect(probe.detached, "the layout and the page never left the DOM").toBe(
    false,
  );
  await expectKept(page, "ccu-layout", "ccu-item");

  // Back: the history entry shows the stats it was left with, and its stale
  // revalidation runs the predicate (stale: true, no action), which holds.
  await page.goBack();
  await expect(page.getByTestId("ccu-item-data")).toHaveText("item:alpha");
  await expect(page).toHaveURL(options.url(`${options.path}/items/alpha`));
  await page.waitForLoadState("networkidle");
  await expect(stats).toHaveText(held);
  await expectKept(page, "ccu-layout", "ccu-item");
}
