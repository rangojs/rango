import { expect, test, type Page } from "@playwright/test";
import { waitForShellHydration } from "./shell-request.js";

/**
 * #1331: a server layout above a clientUrls() group (PLPs, products, /cart)
 * renders a category hero on category pages, and its revalidate() compares
 * the source page's category with the destination's. A prefetch sent from a
 * product page holds the layout, an answer right for that page only. Clicked
 * from a category page, the page must not keep the category page's copy of
 * the layout, the hero, above the destination. Both template shapes: the
 * reporter's, whose <Outlet /> moves, and a fixed one. Fixture:
 * kept-layout-source* in each app, mounted at "/kept-layout-source/two" and
 * "/kept-layout-source/one"; both apps call this from a dev and a
 * (production) describe.
 */
export interface KeptLayoutSourceScenarioOptions {
  url: (pathname: string) => string;
}

/** A hover prefetch of `path`, its body read to the end. */
async function prefetch(page: Page, link: string, path: string): Promise<void> {
  const response = page.waitForResponse(
    (resp) =>
      new URL(resp.url()).pathname === path &&
      resp.request().headers()["x-rango-prefetch"] !== undefined,
  );
  await page.getByTestId(link).hover();
  await (await response).finished();
}

async function open(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await waitForShellHydration(page);
}

export function runKeptLayoutSourceTests(
  options: KeptLayoutSourceScenarioOptions,
): void {
  for (const shape of ["two", "one"] as const) {
    const base = `/kept-layout-source/${shape}`;

    test(`${shape}-shape template: /cart prefetched on a product page, clicked on a category page, shows no hero`, async ({
      page,
    }) => {
      await open(page, options.url(`${base}/p/1`));
      await expect(page.getByTestId("kls-page")).toHaveText("product:1");
      await expect(page.getByTestId("kls-hero")).toHaveCount(0);

      await prefetch(page, "kls-to-cart", `${base}/cart`);

      await page.getByTestId("kls-to-c").click();
      await expect(page.getByTestId("kls-page")).toHaveText("plp:audio");
      await expect(page.getByTestId("kls-hero")).toHaveText("hero:audio");

      await page.getByTestId("kls-to-cart").click();
      await expect(page.getByTestId("kls-page")).toHaveText("cart");
      await expect(page.getByTestId("kls-hero")).toHaveCount(0);
    });

    test(`${shape}-shape template: a product prefetched on a product page, clicked on a category page, shows no hero there or on /cart`, async ({
      page,
    }) => {
      await open(page, options.url(`${base}/p/1`));

      await prefetch(page, "kls-to-p2", `${base}/p/2`);

      await page.getByTestId("kls-to-c").click();
      await expect(page.getByTestId("kls-hero")).toHaveText("hero:audio");

      await page.getByTestId("kls-to-p2").click();
      await expect(page.getByTestId("kls-page")).toHaveText("product:2");
      await expect(page.getByTestId("kls-hero")).toHaveCount(0);

      await page.getByTestId("kls-to-cart").click();
      await expect(page.getByTestId("kls-page")).toHaveText("cart");
      await expect(page.getByTestId("kls-hero")).toHaveCount(0);
    });
  }
}
