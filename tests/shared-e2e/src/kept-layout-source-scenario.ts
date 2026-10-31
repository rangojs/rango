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
 * kept-layout-source* in each app, mounted at "/kept-layout-source/two",
 * "/kept-layout-source/one" and, prerendered, "/kept-layout-source/baked";
 * both apps call this from a dev and a
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

/**
 * Count the RSC requests (prefetches and navigations) the page sends for
 * `path`, from now on.
 */
function countRequests(page: Page, path: string): () => number {
  let count = 0;
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === path && url.searchParams.has("_rsc_partial")) {
      count++;
    }
  });
  return () => count;
}

/** A hover that the prefetch cache answers: no request follows it. */
async function hoverWithoutRequest(
  page: Page,
  link: string,
  requests: () => number,
): Promise<void> {
  const before = requests();
  await page.getByTestId(link).hover();
  // Give a prefetch the time to start: a hover prefetch fires at once.
  await page.waitForTimeout(300);
  expect(requests()).toBe(before);
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

    test(`${shape}-shape template: /cart prefetched on one product page serves another product page with one request, and a category page prefetches its own (rango-t242)`, async ({
      page,
    }) => {
      const cartRequests = countRequests(page, `${base}/cart`);
      await open(page, options.url(`${base}/p/1`));

      await prefetch(page, "kls-to-cart", `${base}/cart`);
      expect(cartRequests()).toBe(1);

      // Another product page is in the group the template's rule read
      // (no category): it adopts the same answer.
      await page.getByTestId("kls-to-p2").click();
      await expect(page.getByTestId("kls-page")).toHaveText("product:2");
      await hoverWithoutRequest(page, "kls-to-cart", cartRequests);
      await page.getByTestId("kls-to-cart").click();
      await expect(page.getByTestId("kls-page")).toHaveText("cart");
      await expect(page.getByTestId("kls-hero")).toHaveCount(0);
      expect(cartRequests()).toBe(1);

      // A category page is not: it prefetches its own, and keeps no hero
      // above /cart.
      await page.getByTestId("kls-to-c").click();
      await expect(page.getByTestId("kls-hero")).toHaveText("hero:audio");
      await prefetch(page, "kls-to-cart", `${base}/cart`);
      expect(cartRequests()).toBe(2);
      await page.getByTestId("kls-to-cart").click();
      await expect(page.getByTestId("kls-page")).toHaveText("cart");
      await expect(page.getByTestId("kls-hero")).toHaveCount(0);
    });
  }

  // The locale rule above paginated pages ("/kept-layout-source/i18n").
  const i18n = "/kept-layout-source/i18n";

  test("locale rule: the home link prefetched on page 1 serves page 2 of the same locale with one request (rango-t242)", async ({
    page,
  }) => {
    const homeRequests = countRequests(page, `${i18n}/en`);
    await open(page, options.url(`${i18n}/en/products?page=1`));
    await expect(page.getByTestId("kls-page")).toHaveText("products:en:1");

    await prefetch(page, "kls-to-home", `${i18n}/en`);
    expect(homeRequests()).toBe(1);

    await page.getByTestId("kls-to-page2").click();
    await expect(page.getByTestId("kls-page")).toHaveText("products:en:2");
    await hoverWithoutRequest(page, "kls-to-home", homeRequests);

    await page.getByTestId("kls-to-home").click();
    await expect(page.getByTestId("kls-page")).toHaveText("home:en");
    await expect(page.getByTestId("kls-locale")).toHaveText("locale:en");
    expect(homeRequests()).toBe(1);
  });

  test("locale rule: the /en home prefetched on an /en page is not adopted by a /fr page, which keeps no /fr layout above /en (rango-t242)", async ({
    page,
  }) => {
    const homeRequests = countRequests(page, `${i18n}/en`);
    await open(page, options.url(`${i18n}/en/products?page=1`));
    await prefetch(page, "kls-to-en-home", `${i18n}/en`);
    expect(homeRequests()).toBe(1);

    await page.getByTestId("kls-to-fr").click();
    await expect(page.getByTestId("kls-page")).toHaveText("products:fr:1");
    await expect(page.getByTestId("kls-locale")).toHaveText("locale:fr");

    // The /en page's answer kept its layout: from /fr the locale changes, so
    // this page asks again and the layout re-renders.
    await prefetch(page, "kls-to-en-home", `${i18n}/en`);
    expect(homeRequests()).toBe(2);
    await page.getByTestId("kls-to-en-home").click();
    await expect(page.getByTestId("kls-page")).toHaveText("home:en");
    await expect(page.getByTestId("kls-locale")).toHaveText("locale:en");
  });

  // Server pages, /cart and /item/:id prerendered ("/kept-layout-source/baked").
  // In production a stored entry serves them: it keeps the template on equal
  // params without asking its revalidate(), and the route's own segment on a
  // search-only change. Dev renders them live.
  const baked = "/kept-layout-source/baked";

  test("prerendered /cart prefetched on a page with the same params, clicked on a category page, shows no hero", async ({
    page,
  }) => {
    await open(page, options.url(`${baked}/wishlist`));
    await expect(page.getByTestId("kls-page")).toHaveText("wishlist");
    await expect(page.getByTestId("kls-hero")).toHaveCount(0);

    await prefetch(page, "kls-to-cart", `${baked}/cart`);

    await page.getByTestId("kls-to-c").click();
    await expect(page.getByTestId("kls-page")).toHaveText("plp:audio");
    await expect(page.getByTestId("kls-hero")).toHaveText("hero:audio");

    await page.getByTestId("kls-to-cart").click();
    await expect(page.getByTestId("kls-page")).toHaveText("cart");
    await expect(page.getByTestId("kls-hero")).toHaveCount(0);
  });

  test("prerendered item prefetched on a search-only change, clicked on another item, shows its own item", async ({
    page,
  }) => {
    await open(page, options.url(`${baked}/item/1?tab=a`));
    await expect(page.getByTestId("kls-page")).toHaveText("item:1");

    await prefetch(page, "kls-to-item1b", `${baked}/item/1`);

    await page.getByTestId("kls-to-item2").click();
    await expect(page.getByTestId("kls-page")).toHaveText("item:2");

    await page.getByTestId("kls-to-item1b").click();
    await expect(page).toHaveURL(/\/item\/1\?tab=b$/);
    await expect(page.getByTestId("kls-page")).toHaveText("item:1");
  });
}
