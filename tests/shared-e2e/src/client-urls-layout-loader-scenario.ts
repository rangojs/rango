import { expect, test, type Page } from "@playwright/test";
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

interface FrameRecord {
  clickAt: number;
  frameAt: number;
  cartAtFrame: string | null;
  canonicalAt: number;
}

/**
 * Time, in the page, from the click on `link` to the first DOM batch that
 * matches one of the `frame` selectors, and to the first that matches
 * `canonical`. The cart the layout shows in that first batch is recorded too.
 */
async function recordClick(
  page: Page,
  link: string,
  frame: readonly string[],
  canonical: string,
): Promise<FrameRecord> {
  await page.evaluate(
    ({ frame, canonical }) => {
      const w = window as unknown as { __cllFrame?: FrameRecord };
      const has = (selector: string) =>
        document.querySelector(selector) !== null;
      const record: FrameRecord = {
        clickAt: 0,
        frameAt: 0,
        cartAtFrame: null,
        canonicalAt: 0,
      };
      w.__cllFrame = record;
      document.addEventListener(
        "click",
        () => {
          record.clickAt = performance.now();
        },
        { capture: true, once: true },
      );
      const observer = new MutationObserver(() => {
        if (record.clickAt === 0) return;
        if (record.frameAt === 0 && frame.some(has)) {
          record.frameAt = performance.now();
          record.cartAtFrame =
            document.querySelector('[data-testid="cll-cart"]')?.textContent ??
            null;
        }
        if (has(canonical)) {
          record.canonicalAt = performance.now();
          observer.disconnect();
        }
      });
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: ["data-pending"],
      });
    },
    { frame: [...frame], canonical },
  );
  await page.getByTestId(link).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { __cllFrame: FrameRecord }).__cllFrame
            .canonicalAt,
      ),
    )
    .toBeGreaterThan(0);
  const record = await page.evaluate(
    () => (window as unknown as { __cllFrame: FrameRecord }).__cllFrame,
  );
  test.info().annotations.push({
    type: "timing",
    description: `${link}: first frame ${Math.round(record.frameAt - record.clickAt)} ms, canonical ${Math.round(record.canonicalAt - record.clickAt)} ms after the click`,
  });
  return record;
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
  expect(toItem.cartAtFrame).toBe(cart);
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
  expect(toIndex.cartAtFrame).toBe(shown);
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
