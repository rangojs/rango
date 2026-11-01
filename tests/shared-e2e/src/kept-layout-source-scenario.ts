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

/**
 * Click a plain anchor to `href` that the router's link interceptor handles
 * and that is never prefetched, then remove it.
 */
async function plainClick(page: Page, href: string): Promise<void> {
  await page.evaluate((to) => {
    const anchor = document.createElement("a");
    anchor.href = to;
    anchor.dataset.prefetch = "none";
    anchor.dataset.testid = "kls-plain";
    anchor.textContent = to;
    document.body.append(anchor);
  }, href);
  await page.getByTestId("kls-plain").click();
  // No wait: the navigation it started may already have replaced it.
  await page.evaluate(() =>
    document.querySelector('[data-testid="kls-plain"]')?.remove(),
  );
}

/**
 * The RSC requests the page sends for `path` from now on: whether each is a
 * prefetch, and the pathname of the source page it names.
 */
function recordSources(
  page: Page,
  path: string,
): { prefetch: boolean; from: string }[] {
  const sources: { prefetch: boolean; from: string }[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname !== path || !url.searchParams.has("_rsc_partial")) return;
    const headers = request.headers();
    const from = headers["x-rsc-router-client-path"];
    sources.push({
      prefetch: headers["x-rango-prefetch"] !== undefined,
      from: from ? new URL(from, url.origin).pathname : "?",
    });
  });
  return sources;
}

/**
 * Hold every RSC request for `path` until `release()` is called, never on a
 * timer: a slow worker must not let the held request finish before the test
 * has clicked. `started` resolves once the first such request is sent.
 */
async function holdPartials(
  page: Page,
  path: string,
): Promise<{ started: Promise<unknown>; release: () => void }> {
  const isPartial = (url: URL) =>
    url.pathname === path && url.searchParams.has("_rsc_partial");
  let release: () => void = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(isPartial, async (route) => {
    await released;
    // A newer navigation aborts the request while it waits.
    await route.continue().catch(() => {});
  });
  return {
    started: page.waitForRequest((request) =>
      isPartial(new URL(request.url())),
    ),
    release,
  };
}

/**
 * Open product 1, push it out of the router's 20-entry history cache, go to
 * the category page (hero shown), then Back to product 1 with its RSC
 * request held: window.location is product 1 while the router still shows
 * the category page. Resolves once that request has started, with the
 * function that lets it go; the Back stays uncommitted until it is called.
 */
async function startSlowBackToProduct(
  page: Page,
  url: string,
  base: string,
): Promise<() => void> {
  await open(page, url);
  for (let i = 0; i < 20; i++) {
    await plainClick(page, `${base}/p/f${i}`);
    await expect(page.getByTestId("kls-page")).toHaveText(`product:f${i}`);
  }
  await page.getByTestId("kls-to-c").click();
  await expect(page.getByTestId("kls-page")).toHaveText("plp:audio");
  await expect(page.getByTestId("kls-hero")).toHaveText("hero:audio");

  const back = await holdPartials(page, `${base}/p/1`);
  await page.evaluate(() => history.go(-21));
  await back.started;
  await expect(page).toHaveURL(new RegExp(`${base}/p/1$`));
  // The Back has not committed: the category page is still on screen.
  await expect(page.getByTestId("kls-page")).toHaveText("plp:audio");
  return back.release;
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

  // A click while a Back/Forward that missed the history cache still loads
  // (rango-t250): window.location is the popped entry, the router still
  // shows the page being left. The request must name that page as its
  // source, with the segments it holds, or the server keeps the template
  // for product 1 -> product 2 and the category page's copy stays.
  const two = "/kept-layout-source/two";

  test("a product clicked (prefetched on hover) while a slow Back loads shows no hero there or on /cart", async ({
    page,
  }) => {
    const release = await startSlowBackToProduct(
      page,
      options.url(`${two}/p/1`),
      two,
    );
    try {
      const p2 = recordSources(page, `${two}/p/2`);

      await page.getByTestId("kls-to-p2").click();
      await expect(page).toHaveURL(new RegExp(`${two}/p/2$`));
      await expect(page.getByTestId("kls-page")).toHaveText("product:2");
      await expect(page.getByTestId("kls-hero")).toHaveCount(0);
      // The hover's prefetch served the click, sent from the page on screen.
      expect(p2[0]).toEqual({ prefetch: true, from: `${two}/c/audio` });

      await page.getByTestId("kls-to-cart").click();
      await expect(page.getByTestId("kls-page")).toHaveText("cart");
      await expect(page.getByTestId("kls-hero")).toHaveCount(0);
    } finally {
      release();
    }
  });

  test("a product clicked (not prefetched) while a slow Back loads shows no hero there or on /cart", async ({
    page,
  }) => {
    const release = await startSlowBackToProduct(
      page,
      options.url(`${two}/p/1`),
      two,
    );
    try {
      const p2 = recordSources(page, `${two}/p/2`);

      await plainClick(page, `${two}/p/2`);
      await expect(page).toHaveURL(new RegExp(`${two}/p/2$`));
      await expect(page.getByTestId("kls-page")).toHaveText("product:2");
      await expect(page.getByTestId("kls-hero")).toHaveCount(0);
      // One navigation request, sent from the page on screen.
      expect(p2).toEqual([{ prefetch: false, from: `${two}/c/audio` }]);

      await page.getByTestId("kls-to-cart").click();
      await expect(page.getByTestId("kls-page")).toHaveText("cart");
      await expect(page.getByTestId("kls-hero")).toHaveCount(0);
    } finally {
      release();
    }
  });

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
