import { expect, type Page } from "@playwright/test";
import { recordFirstFrame } from "./first-frame.js";
import { readProbe, watchFlash } from "./flash-probe.js";

/**
 * A clientUrls() group under a parameterized include(), behind a 400 ms
 * server middleware. Fixture: client-urls-locale* in each app, mounted at
 * "/client-urls-locale/:locale" and "/client-urls-olocale/:locale?".
 */
export interface ClientUrlsLocaleOptions {
  url: (pathname: string) => string;
  /** The group's index under one mount instance ("/client-urls-locale/en"). */
  path: string;
  /** The mount's locale there; "-" when an optional one is absent. */
  locale: string;
}

/** The server middleware's delay over the group (both apps' urls.tsx). */
const SERVER_DELAY_MS = 400;
/** A first frame later than this waited for the server. */
const FIRST_FRAME_MS = 150;

async function openIndex(
  page: Page,
  options: ClientUrlsLocaleOptions,
): Promise<void> {
  await page.goto(options.url(options.path));
  await expect(page.getByTestId("clo-index")).toBeVisible();
  await page.waitForFunction(() =>
    document.documentElement.hasAttribute("data-hydrated"),
  );
  await expect(page.getByTestId("clo-locale")).toHaveText(options.locale);
  await page
    .getByTestId("clo-layout")
    .evaluate((el) => el.setAttribute("data-e2e-kept", "1"));
  // Only the reload and detach probes: the group has no fallback to flash.
  await watchFlash(page, "clo-no-fallback", ["clo-layout"]);
}

async function expectLayoutKept(page: Page): Promise<void> {
  await expect(page.getByTestId("clo-layout")).toHaveAttribute(
    "data-e2e-kept",
    "1",
  );
  const probe = await readProbe(page);
  expect(probe.installed, "no document reload").toBe(true);
  expect(probe.detached, "the layout never left the DOM").toBe(false);
}

/**
 * A click between the group's routes presents the destination at the click,
 * as under a literal mount: its loading() reads the mount's locale from
 * useParams() in the frame, and the item commits with the server's answer.
 * The layout keeps its element across the click, a param navigation, a
 * server action, the return to the index and Back.
 */
export async function expectParamMountClickRendersAtTheClick(
  page: Page,
  options: ClientUrlsLocaleOptions,
): Promise<void> {
  await openIndex(page, options);

  const toItem = await recordFirstFrame(
    page,
    "clo-to-alpha",
    ['[data-testid="clo-item-loading"]', '[data-testid="clo-item"]'],
    '[data-testid="clo-item-data"]',
    '[data-testid="clo-item-loading"]',
  );
  expect(
    toItem.frameAt - toItem.clickAt,
    "the destination shows at the click",
  ).toBeLessThan(FIRST_FRAME_MS);
  expect(toItem.textAtFrame, "useParams() in the frame has the locale").toBe(
    `loading:${options.locale}:alpha`,
  );
  expect(
    toItem.canonicalAt - toItem.clickAt,
    "the item waited for the server",
  ).toBeGreaterThanOrEqual(SERVER_DELAY_MS - 50);
  await expect(page.getByTestId("clo-item-data")).toHaveText(
    `item:${options.locale}:alpha`,
  );
  await expect(page).toHaveURL(options.url(`${options.path}/items/alpha`));
  await expect(page.getByTestId("clo-locale")).toHaveText(options.locale);

  // A param navigation on the same route, then a server action.
  await page.getByTestId("clo-to-beta").click();
  await expect(page.getByTestId("clo-item-data")).toHaveText(
    `item:${options.locale}:beta`,
  );
  await expect(page).toHaveURL(options.url(`${options.path}/items/beta`));
  await page.getByTestId("clo-action").click();
  await expect(page.getByTestId("clo-echo")).toHaveText("echo:beta");
  await expect(page.getByTestId("clo-locale")).toHaveText(options.locale);
  await expect(page.getByTestId("clo-layout")).toHaveAttribute(
    "data-e2e-kept",
    "1",
  );

  const toIndex = await recordFirstFrame(
    page,
    "clo-to-index",
    ['[data-testid="clo-index"]'],
    '[data-testid="clo-layout"][data-pending="false"] [data-testid="clo-index"]',
  );
  expect(
    toIndex.frameAt - toIndex.clickAt,
    "the index shows at the click",
  ).toBeLessThan(FIRST_FRAME_MS);
  expect(
    toIndex.canonicalAt - toIndex.clickAt,
    "the index committed with the server's answer",
  ).toBeGreaterThanOrEqual(SERVER_DELAY_MS - 50);
  await expect(page).toHaveURL(options.url(options.path));

  await page.goBack();
  await expect(page.getByTestId("clo-item-data")).toHaveText(
    `item:${options.locale}:beta`,
  );
  await expectLayoutKept(page);
}

/**
 * The group's own intercept (intercept("@modal", ".note")) opens from an
 * in-group origin under the parameterized mount: the modal over the index,
 * not the full note page.
 */
export async function expectParamMountInterceptOpens(
  page: Page,
  options: ClientUrlsLocaleOptions,
): Promise<void> {
  await openIndex(page, options);
  await page.getByTestId("clo-to-note").click();
  await expect(page.getByTestId("clo-note-modal")).toHaveText("modal:n1");
  await expect(page).toHaveURL(options.url(`${options.path}/notes/n1`));
  await expect(page.getByTestId("clo-index")).toBeVisible();
  await expect(page.getByTestId("clo-note")).toHaveCount(0);
  await expectLayoutKept(page);
}

/**
 * A locale switch to another route
 * (`reverse(".item", { itemId: "alpha", locale: "de" })`, from the index) is
 * another instance of the group: no frame, the destination shows when the
 * server answers, as a plain link's does, with the layout's element kept. A
 * click inside the new instance then presents at the click with its locale.
 */
export async function expectParamMountLocaleSwitchNavigates(
  page: Page,
  options: ClientUrlsLocaleOptions & { germanPath: string },
): Promise<void> {
  await openIndex(page, options);
  const toGerman = await recordFirstFrame(
    page,
    "clo-to-de",
    ['[data-testid="clo-item-loading"]', '[data-testid="clo-item"]'],
    '[data-testid="clo-item-data"]',
  );
  expect(
    toGerman.frameAt - toGerman.clickAt,
    "no frame: the other locale's item waited for the server",
  ).toBeGreaterThanOrEqual(SERVER_DELAY_MS - 50);
  await expect(page.getByTestId("clo-item-data")).toHaveText("item:de:alpha");
  await expect(page).toHaveURL(
    options.url(`${options.germanPath}/items/alpha`),
  );
  await expect(page.getByTestId("clo-locale")).toHaveText("de");
  await expect(page.getByTestId("clo-layout")).toHaveAttribute(
    "data-pending",
    "false",
  );
  await expectLayoutKept(page);

  const toIndex = await recordFirstFrame(
    page,
    "clo-to-index",
    ['[data-testid="clo-index"]'],
    '[data-testid="clo-layout"][data-pending="false"] [data-testid="clo-index"]',
  );
  expect(toIndex.frameAt - toIndex.clickAt).toBeLessThan(FIRST_FRAME_MS);
  await expect(page).toHaveURL(options.url(options.germanPath));
  await expect(page.getByTestId("clo-locale")).toHaveText("de");
}
