import { expect, type Page } from "@playwright/test";
import { recordFirstFrame, type FirstFrameRecord } from "./first-frame.js";
import { readProbe, watchFlash } from "./flash-probe.js";

/**
 * A clientUrls() group whose layout() reads its own loader, directly and in
 * an inline <Suspense> (the vite-rsc-demo ClientShopLayout / CartBadge
 * shape), behind a 400 ms server middleware. Fixture:
 * client-urls-layout-loader* in each app.
 */
export interface ClientUrlsLayoutLoaderOptions {
  url: (pathname: string) => string;
  /** The group's include() mount. */
  path: string;
}

/** The server middleware's delay over the group (both apps' urls.tsx). */
const SERVER_DELAY_MS = 400;
/** A first frame later than this waited for the server. */
const FIRST_FRAME_MS = 150;

/** recordFirstFrame, reading the cart the layout shows in the first frame. */
function recordClick(
  page: Page,
  link: string,
  frame: readonly string[],
  canonical: string,
): Promise<FirstFrameRecord> {
  return recordFirstFrame(
    page,
    link,
    frame,
    canonical,
    '[data-testid="cll-cart"]',
  );
}

async function expectLayoutKept(page: Page): Promise<void> {
  await expect(page.getByTestId("cll-layout")).toHaveAttribute(
    "data-e2e-kept",
    "1",
  );
  await expect(page.getByTestId("cll-cart")).toHaveAttribute(
    "data-e2e-kept",
    "1",
  );
}

/**
 * A navigation between the group's routes presents the destination at the
 * click: the kept layout reads the cart it already has instead of suspending
 * on the destination's pending loaders, so React does not hold the frame
 * until the server answers. The layout keeps its instance across a route
 * switch, a param navigation, an action and Back, and its cart badge never
 * shows its fallback.
 */
export async function expectKeptLayoutReadingItsLoaderKeepsTheOptimisticFrame(
  page: Page,
  options: ClientUrlsLayoutLoaderOptions,
): Promise<void> {
  await page.goto(options.url(options.path));
  await expect(page.getByTestId("cll-index")).toBeVisible();
  await page.waitForFunction(() =>
    document.documentElement.hasAttribute("data-hydrated"),
  );
  const cart = (await page.getByTestId("cll-cart").textContent()) ?? "";
  expect(cart).toMatch(/^cart:\d+$/);
  for (const id of ["cll-layout", "cll-cart"]) {
    await page
      .getByTestId(id)
      .evaluate((el) => el.setAttribute("data-e2e-kept", "1"));
  }
  await watchFlash(page, "cll-badge-fallback", ["cll-layout"]);

  // Cross-route: the destination's loading() at the click, the layout's cart
  // as it was, the item after the server delay.
  const toItem = await recordClick(
    page,
    "cll-to-alpha",
    ['[data-testid="cll-item-loading"]', '[data-testid="cll-item"]'],
    '[data-testid="cll-item-data"]',
  );
  expect(
    toItem.frameAt - toItem.clickAt,
    "the destination shows at the click",
  ).toBeLessThan(FIRST_FRAME_MS);
  expect(toItem.textAtFrame).toBe(cart);
  expect(
    toItem.canonicalAt - toItem.clickAt,
    "the item waited for the server",
  ).toBeGreaterThanOrEqual(SERVER_DELAY_MS - 50);
  await expect(page.getByTestId("cll-item-data")).toHaveText("item:alpha");
  await expect(page.getByTestId("cll-layout")).toHaveAttribute(
    "data-pending",
    "false",
  );
  await expectLayoutKept(page);

  // Param navigation on the same route.
  await page.getByTestId("cll-to-beta").click();
  await expect(page.getByTestId("cll-item-data")).toHaveText("item:beta");
  await expectLayoutKept(page);

  // A server action re-runs the layout's loader in place.
  await page.getByTestId("cll-bump").click();
  const bumped = `cart:${Number(cart.slice("cart:".length)) + 1}`;
  await expect(page.getByTestId("cll-cart")).toHaveText(bumped);
  await expect(page.getByTestId("cll-badge")).toHaveText(bumped);
  await expectLayoutKept(page);

  await page.goBack();
  await expect(page.getByTestId("cll-item-data")).toHaveText("item:alpha");
  await expectLayoutKept(page);

  // Cross-route to a route with no loader of its own.
  const shown = await page.getByTestId("cll-cart").textContent();
  const toIndex = await recordClick(
    page,
    "cll-to-index",
    ['[data-testid="cll-index"]'],
    '[data-testid="cll-layout"][data-pending="false"] [data-testid="cll-index"]',
  );
  expect(
    toIndex.frameAt - toIndex.clickAt,
    "the index shows at the click",
  ).toBeLessThan(FIRST_FRAME_MS);
  expect(toIndex.textAtFrame).toBe(shown);
  expect(
    toIndex.canonicalAt - toIndex.clickAt,
    "the index committed with the server's answer",
  ).toBeGreaterThanOrEqual(SERVER_DELAY_MS - 50);
  await expect(page.getByTestId("cll-layout")).toHaveAttribute(
    "data-pending",
    "false",
  );
  await expect(page).toHaveURL(options.url(options.path));
  await expectLayoutKept(page);

  const probe = await readProbe(page);
  expect(probe.installed, "no document reload").toBe(true);
  expect(probe.flash, "the cart badge never showed its fallback").toBe(false);
  expect(probe.detached, "the layout never left the DOM").toBe(false);
}

/**
 * A click to the committed route, with other params, made while another
 * route's optimistic frame is on screen (item alpha committed, a click to the
 * index, a click to item gamma before the index commits): the router aborted
 * the index navigation, so alpha is still the committed route. The click
 * presents gamma with its own loader pending, as any route change does; the
 * committed alpha page and its data never come back on screen. The layout
 * keeps its instance and its cart.
 */
export async function expectReturnToCommittedRouteFromOptimisticFrameShowsTheDestination(
  page: Page,
  options: ClientUrlsLayoutLoaderOptions,
): Promise<void> {
  await page.goto(options.url(`${options.path}/items/alpha`));
  await expect(page.getByTestId("cll-item-data")).toHaveText("item:alpha");
  await page.waitForFunction(() =>
    document.documentElement.hasAttribute("data-hydrated"),
  );
  const cart = await page.getByTestId("cll-cart").textContent();
  await page
    .getByTestId("cll-layout")
    .evaluate((el) => el.setAttribute("data-e2e-kept", "1"));
  await watchFlash(page, "cll-badge-fallback", ["cll-layout"]);

  await page.getByTestId("cll-to-index").click();
  await expect(page.getByTestId("cll-index")).toBeVisible();

  // From the gamma click on: was the index still uncommitted at the click,
  // did the committed alpha page come back, did gamma's loading() show.
  await page.evaluate(() => {
    const w = window as unknown as {
      __cllReturn?: { atClick: string; alpha: boolean; loading: boolean };
    };
    const record = { atClick: "", alpha: false, loading: false };
    w.__cllReturn = record;
    const check = () => {
      if (
        document.querySelector('[data-testid="cll-item-data"]')?.textContent ===
        "item:alpha"
      ) {
        record.alpha = true;
      }
      if (document.querySelector('[data-testid="cll-item-loading"]')) {
        record.loading = true;
      }
    };
    document.addEventListener(
      "click",
      () => {
        record.atClick =
          document
            .querySelector('[data-testid="cll-layout"]')
            ?.getAttribute("data-pending") ?? "";
        new MutationObserver(check).observe(document.body, {
          childList: true,
          subtree: true,
          characterData: true,
        });
      },
      { capture: true, once: true },
    );
  });
  await page.getByTestId("cll-to-gamma").click();
  await expect(page.getByTestId("cll-item-data")).toHaveText("item:gamma");
  await expect(page).toHaveURL(options.url(`${options.path}/items/gamma`));

  const record = await page.evaluate(
    () =>
      (
        window as unknown as {
          __cllReturn: { atClick: string; alpha: boolean; loading: boolean };
        }
      ).__cllReturn,
  );
  expect(record.atClick, "the click landed on the optimistic index").toBe(
    "true",
  );
  expect(record.alpha, "the committed alpha page never came back").toBe(false);
  expect(record.loading, "gamma showed its loading() at the click").toBe(true);
  await expect(page.getByTestId("cll-cart")).toHaveText(cart ?? "");
  await expect(page.getByTestId("cll-layout")).toHaveAttribute(
    "data-e2e-kept",
    "1",
  );
  const probe = await readProbe(page);
  expect(probe.installed, "no document reload").toBe(true);
  expect(probe.flash, "the cart badge never showed its fallback").toBe(false);
  expect(probe.detached, "the layout never left the DOM").toBe(false);
}

/** The wait of the layout's runs loader (both apps' loader.ts). */
const LAYOUT_LOADER_MS = 300;

/**
 * A layout() loader with no revalidate() (the runs loader: it takes 300 ms
 * and pushes a crumb) takes a server layout's default: it keeps its data and
 * its crumb across navigations between the layout's routes, a param
 * navigation, a search-only change and Back, and neither cross-route canonical
 * commit waits for it. An action re-runs it. The layout keeps its instance
 * throughout, and its cart badge never shows its fallback.
 */
export async function expectLayoutLoaderHeldAcrossNavigations(
  page: Page,
  options: ClientUrlsLayoutLoaderOptions,
): Promise<void> {
  await page.goto(options.url(options.path));
  await expect(page.getByTestId("cll-index")).toBeVisible();
  await page.waitForFunction(() =>
    document.documentElement.hasAttribute("data-hydrated"),
  );
  const runs = (await page.getByTestId("cll-runs").textContent()) ?? "";
  expect(runs).toMatch(/^runs:\d+$/);
  await expect(page.getByTestId("cll-crumbs")).toHaveText(runs);
  for (const id of ["cll-layout", "cll-cart"]) {
    await page
      .getByTestId(id)
      .evaluate((el) => el.setAttribute("data-e2e-kept", "1"));
  }
  await watchFlash(page, "cll-badge-fallback", ["cll-layout"]);

  const held = async (): Promise<void> => {
    await expect(page.getByTestId("cll-runs")).toHaveText(runs);
    await expect(page.getByTestId("cll-crumbs")).toHaveText(runs);
    await expectLayoutKept(page);
  };
  const committedWithoutTheLoader = (record: FirstFrameRecord): void =>
    expect(
      record.canonicalAt - record.clickAt,
      "the canonical commit did not wait for the layout's loader",
    ).toBeLessThan(SERVER_DELAY_MS + LAYOUT_LOADER_MS);

  committedWithoutTheLoader(
    await recordClick(
      page,
      "cll-to-alpha",
      ['[data-testid="cll-item-loading"]', '[data-testid="cll-item"]'],
      '[data-testid="cll-item-data"]',
    ),
  );
  await expect(page.getByTestId("cll-item-data")).toHaveText("item:alpha");
  await held();

  // A param navigation on the same route, Back, and a search-only change.
  await page.getByTestId("cll-to-beta").click();
  await expect(page.getByTestId("cll-item-data")).toHaveText("item:beta");
  await held();
  await page.goBack();
  await expect(page.getByTestId("cll-item-data")).toHaveText("item:alpha");
  await held();
  await page.getByTestId("cll-to-alpha-compact").click();
  await expect(page).toHaveURL(
    options.url(`${options.path}/items/alpha?view=compact`),
  );
  await expect(page.getByTestId("cll-layout")).toHaveAttribute(
    "data-pending",
    "false",
  );
  await held();

  committedWithoutTheLoader(
    await recordClick(
      page,
      "cll-to-index",
      ['[data-testid="cll-index"]'],
      '[data-testid="cll-layout"][data-pending="false"] [data-testid="cll-index"]',
    ),
  );
  await expect(page).toHaveURL(options.url(options.path));
  await held();

  // An action re-runs it in place. Not the bump action: the cart count
  // another test of this group checks stays its own.
  await page.getByTestId("cll-rerun").click();
  await expect(page.getByTestId("cll-runs")).not.toHaveText(runs);
  const rerun = (await page.getByTestId("cll-runs").textContent()) ?? "";
  expect(rerun).toMatch(/^runs:\d+$/);
  await expect(page.getByTestId("cll-crumbs")).toHaveText(rerun);
  await expectLayoutKept(page);

  const probe = await readProbe(page);
  expect(probe.installed, "no document reload").toBe(true);
  expect(probe.flash, "the cart badge never showed its fallback").toBe(false);
  expect(probe.detached, "the layout never left the DOM").toBe(false);
}
