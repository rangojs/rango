import { expect, type Page } from "@playwright/test";
import { recordFirstFrame } from "./first-frame.js";
import { readProbe, watchFlash } from "./flash-probe.js";

/**
 * A clientUrls() group whose first route after the mount is a param
 * (`/:slug`), beside server routes its URLs also match, behind a 400 ms
 * server middleware. Fixture: client-urls-compete* in each app, mounted at
 * "/client-urls-ocompete/:locale?" (beside an unnamed ".../login") and
 * "/client-urls-compete/:locale" (beside ".../:locale/about").
 */
export interface ClientUrlsCompeteOptions {
  url: (pathname: string) => string;
  /** A product page of the group ("/client-urls-ocompete/shoe"). */
  path: string;
  /** The link to the server route, its slug and URL, and its page's text. */
  competitor: {
    link: string;
    slug: string;
    path: string;
    text: string;
  };
}

/** The server middleware's delay over the group (both apps' urls.tsx). */
const SERVER_DELAY_MS = 400;
/** A first frame later than this waited for the server. */
const FIRST_FRAME_MS = 150;

/**
 * A click between the group's routes renders at the click. A click to a URL
 * the server routes to the route beside the group shows no frame of the
 * group's `/:slug` route, and lands on the server's page. Its link to the
 * group's intercept target opens the full page: the group's modal opens only
 * from the group's own routes.
 */
export async function expectCompetingServerRouteGetsNoFrame(
  page: Page,
  options: ClientUrlsCompeteOptions,
): Promise<void> {
  const slug = options.path.slice(options.path.lastIndexOf("/") + 1);
  await page.goto(options.url(options.path));
  await expect(page.getByTestId(`cmp-product-${slug}`)).toBeVisible();
  await page.waitForFunction(() =>
    document.documentElement.hasAttribute("data-hydrated"),
  );
  await page
    .getByTestId("cmp-layout")
    .evaluate((el) => el.setAttribute("data-e2e-kept", "1"));

  const toItem = await recordFirstFrame(
    page,
    "cmp-to-item",
    ['[data-testid="cmp-item-loading"]', '[data-testid="cmp-item-data"]'],
    '[data-testid="cmp-item-data"]',
  );
  expect(
    toItem.frameAt - toItem.clickAt,
    "the item shows at the click",
  ).toBeLessThan(FIRST_FRAME_MS);
  expect(
    toItem.canonicalAt - toItem.clickAt,
    "the item waited for the server",
  ).toBeGreaterThanOrEqual(SERVER_DELAY_MS - 50);
  await expect(page.getByTestId("cmp-item-data")).toHaveText("item:alpha");
  await expect(page.getByTestId("cmp-layout")).toHaveAttribute(
    "data-e2e-kept",
    "1",
  );

  const { competitor } = options;
  await watchFlash(page, `cmp-product-${competitor.slug}`);
  await page.getByTestId(competitor.link).click();
  await expect(page).toHaveURL(options.url(competitor.path));
  await expect(page.getByTestId("cmp-server")).toContainText(competitor.text);
  const probe = await readProbe(page);
  expect(probe.installed, "no document reload").toBe(true);
  expect(probe.flash, "no frame of the group's /:slug route").toBe(false);

  await page.getByTestId("cmp-server-to-detail").click();
  await expect(page.getByTestId("cmp-detail")).toHaveText("detail:1");
  await expect(page.getByTestId("cmp-modal")).toHaveCount(0);
}
