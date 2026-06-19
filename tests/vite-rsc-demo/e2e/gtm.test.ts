import { expect, test, type Page } from "@playwright/test";
import { test as devTest, devURL } from "./dev-fixture";
import {
  prodDescribe,
  waitForHydration,
  expectNoPageError,
  testId,
} from "./helper";

/**
 * GTM integration coverage. Verifies, in BOTH dev and production:
 *  - the nonced GTM scripts (external gtm.js loader + inline dataLayer init) are
 *    injected into the document <head> and survive hydration with no errors;
 *  - the no-JS server render contains the SAME head scripts as the hydrated app;
 *  - the CSP header carries the same nonce stamped on the GTM scripts;
 *  - dataLayer receives a page_view on first render and on soft navigation, plus
 *    view_item (from loader data) and add_to_cart ecommerce events.
 *
 * dev/prod parity: each check is a shared function called from a dev describe and
 * from prodDescribe (which tags the title "(production)" and wires the build
 * fixture). The no-JS half runs in both buckets via a nested describe with
 * javaScriptEnabled disabled.
 */

type Url = (path: string) => string;

interface DataLayerEvent {
  event?: string;
  page_path?: string;
  page_location?: string;
  page_title?: string;
  page_referrer?: string;
  content_group?: string;
  ecommerce?: {
    value?: number;
    currency?: string;
    items?: Array<{ item_id?: string; quantity?: number }>;
  } | null;
  [key: string]: unknown;
}

function readDataLayer(page: Page): Promise<DataLayerEvent[]> {
  return page.evaluate(
    () =>
      (window as unknown as { dataLayer?: DataLayerEvent[] }).dataLayer ?? [],
  );
}

async function pageViewPaths(page: Page): Promise<(string | undefined)[]> {
  const dl = await readDataLayer(page);
  return dl.filter((e) => e.event === "page_view").map((e) => e.page_path);
}

// Head-scoped: matches the gtm.js loader element, which the inline bootstrap
// INJECTS into <head> at runtime (so it exists with JS, not without).
const GTM_LOADER = 'head script[src*="googletagmanager.com/gtm.js"]';

// Assert the GTM head injection. The inline bootstrap (which initialises
// dataLayer, emits the first page_view, and wires gtm.js) is ALWAYS in <head> —
// identical markup with or without JS. The gtm.js loader element is injected by
// that script at runtime, so it is present only when JS ran (loaderInjected).
async function expectGtmInHead(page: Page, loaderInjected: boolean) {
  const headInline = await page
    .locator("head script:not([src])")
    .allTextContents();
  const bootstrap = headInline.find((s) => s.includes("window.dataLayer"));
  expect(bootstrap, "inline GTM bootstrap is in <head>").toBeTruthy();
  expect(bootstrap, "bootstrap emits the first page_view").toContain(
    "page_view",
  );
  expect(bootstrap, "bootstrap wires the gtm.js loader").toContain(
    "googletagmanager.com/gtm.js",
  );
  await expect(
    page.locator(GTM_LOADER),
    loaderInjected
      ? "gtm.js loader injected into <head>"
      : "gtm.js loader NOT injected without JS",
  ).toHaveCount(loaderInjected ? 1 : 0);
}

// First render emits exactly one page_view (from the SSR inline init, not a
// hydration double-fire); a soft navigation appends a second. The bootstrap is
// in <head>, the loader is injected, and hydration is clean.
async function checkFirstRenderAndNav(page: Page, url: Url) {
  using _ = expectNoPageError(page);

  await page.goto(url("/"));
  await waitForHydration(page);

  await expectGtmInHead(page, true);
  expect(await pageViewPaths(page)).toEqual(["/"]);

  // Soft navigation via a client-side <Link>.
  await page.locator('nav a[href="/about"]').first().click();
  await expect(page.locator("h1, h2").first()).toBeVisible();

  await expect.poll(() => pageViewPaths(page)).toEqual(["/", "/about"]);
}

// A soft navigation's page_view carries the SAME complete payload as the first
// render: handle tagging (page_path, content_group) plus the GA4-recommended
// runtime fields (page_location, page_title, page_referrer) — not just page_path.
async function checkSoftNavPayload(page: Page, url: Url) {
  using _ = expectNoPageError(page);

  await page.goto(url("/"));
  await waitForHydration(page);

  await page.locator('nav a[href="/gtm"]').first().click();
  await expect(testId(page, "gtm-demo")).toBeVisible();

  // Wait until the /gtm page_view has landed in dataLayer.
  await expect
    .poll(async () => {
      const dl = await readDataLayer(page);
      return dl.some((e) => e.event === "page_view" && e.page_path === "/gtm");
    })
    .toBe(true);

  const dl = await readDataLayer(page);
  const pv = dl.filter((e) => e.event === "page_view").at(-1)!;
  expect(pv.page_path).toBe("/gtm");
  expect(pv.content_group, "handle metadata carried on soft nav").toBe("demo");
  expect(pv.page_title, "page_title from document.title (Meta)").toBe(
    "GTM Demo",
  );
  expect(pv.page_location, "page_location is the full URL").toContain("/gtm");
  expect(typeof pv.page_referrer, "page_referrer is set").toBe("string");
}

// A HARD load of /gtm: the single page_view (from the inline bootstrap) must
// carry the correct server-rendered page_title — not the parse-time title of a
// competing manual <title>. Regression guard for the two-<title> bug.
async function checkInitialPageTitle(page: Page, url: Url) {
  using _ = expectNoPageError(page);

  await page.goto(url("/gtm"));
  await waitForHydration(page);
  await expect(testId(page, "gtm-demo")).toBeVisible();

  const dl = await readDataLayer(page);
  const pageViews = dl.filter((e) => e.event === "page_view");
  // Hard load: exactly one page_view (the inline bootstrap; GtmPageViews seeds
  // and does not double-fire on mount).
  expect(pageViews.map((e) => e.page_path)).toEqual(["/gtm"]);
  expect(
    pageViews[0]?.page_title,
    "initial page_view page_title matches the rendered document title",
  ).toBe("GTM Demo");
}

// view_item is fired once from the route loader's data; add_to_cart on click.
// Both carry ecommerce value = price x quantity.
async function checkEcommerce(page: Page, url: Url) {
  using _ = expectNoPageError(page);

  await page.goto(url("/gtm"));
  await waitForHydration(page);
  await expect(testId(page, "gtm-demo")).toBeVisible();

  await expect
    .poll(async () =>
      (await readDataLayer(page)).filter((e) => e.event === "view_item"),
    )
    .toHaveLength(1);
  const dl = await readDataLayer(page);
  const viewItem = dl.find((e) => e.event === "view_item");
  expect(viewItem?.ecommerce?.items?.[0]?.item_id).toBe("demo-widget");
  expect(viewItem?.ecommerce?.value, "view_item value = price x 1").toBe(19.99);

  await testId(page, "gtm-add-to-cart").click();
  await expect
    .poll(async () =>
      (await readDataLayer(page)).filter((e) => e.event === "add_to_cart"),
    )
    .toHaveLength(1);
  const addToCart = (await readDataLayer(page)).find(
    (e) => e.event === "add_to_cart",
  );
  expect(addToCart?.ecommerce?.items?.[0]?.quantity, "qty 1").toBe(1);
  expect(addToCart?.ecommerce?.value, "add_to_cart value = price x qty").toBe(
    19.99,
  );
}

// The CSP header carries a nonce, and the SAME nonce is stamped on the GTM
// scripts in the raw SSR HTML (browsers blank script.nonce in the live DOM, so
// the nonce must be asserted on the response body, not the DOM). The first
// page_view is in the static HTML, head-before-body.
//
// `enforced` pins the mode contract: production must emit the ENFORCING
// Content-Security-Policy (not Report-Only), and dev must emit Report-Only. The
// opposite header must be absent, so a regression to the wrong mode fails here.
async function checkCspAndNonce(page: Page, url: Url, enforced: boolean) {
  const res = await page.request.get(url("/"), {
    headers: { Accept: "text/html,application/xhtml+xml" },
  });
  const headers = res.headers();
  const activeHeader = enforced
    ? "content-security-policy"
    : "content-security-policy-report-only";
  const inactiveHeader = enforced
    ? "content-security-policy-report-only"
    : "content-security-policy";
  const csp = headers[activeHeader];
  expect(csp, `${activeHeader} is set on the HTML response`).toBeTruthy();
  expect(
    headers[inactiveHeader],
    `${inactiveHeader} must NOT be set in this mode`,
  ).toBeFalsy();
  expect(csp).toContain("https://*.googletagmanager.com");
  const cspNonce = csp!.match(/'nonce-([^']+)'/)?.[1];
  expect(cspNonce, "the CSP names a nonce").toBeTruthy();

  const html = await res.text();
  // The nonced inline bootstrap is in the SSR HTML and wires the gtm.js loader.
  const scriptNonces = [...html.matchAll(/<script[^>]*\snonce="([^"]+)"/g)].map(
    (m) => m[1],
  );
  expect(
    scriptNonces,
    "the inline GTM script carries the CSP nonce in the SSR HTML",
  ).toContain(cspNonce);

  expect(html, "first page_view is in the static HTML").toContain(
    'event:"page_view"',
  );

  // dataLayer is initialised BEFORE gtm.js is injected (Google's bootstrap
  // contract). Both live in the single inline script, so this is just text
  // order; injecting from the inline script also guarantees gtm.js cannot run
  // before dataLayer exists (a declarative <script async> would be hoisted above).
  const initIdx = html.indexOf("window.dataLayer=window.dataLayer||[]");
  const loaderIdx = html.indexOf("googletagmanager.com/gtm.js");
  expect(initIdx, "dataLayer init is present").toBeGreaterThanOrEqual(0);
  expect(
    loaderIdx,
    "gtm.js injection comes after dataLayer init",
  ).toBeGreaterThan(initIdx);

  expect(
    html.indexOf("googletagmanager"),
    "GTM bootstrap is in <head>, before <body>",
  ).toBeLessThan(html.indexOf("<body"));
}

// Without JavaScript, the server HTML still contains the SAME GTM <head> scripts
// as the hydrated app (parity), plus the <noscript> fallback iframe.
async function checkNoJsHead(page: Page, url: Url) {
  await page.goto(url("/"));

  // The inline bootstrap markup is identical to the hydrated app; the loader is
  // NOT injected (no JS), so the <noscript> iframe is the fallback.
  await expectGtmInHead(page, false);

  await expect(page.locator("noscript")).toBeAttached();
}

// ---------------------------------------------------------------------------
// dev
// ---------------------------------------------------------------------------
devTest.describe("gtm", () => {
  devTest(
    "page_view on first render + soft nav",
    async ({ page, devServerURL }) => {
      await checkFirstRenderAndNav(page, (p) => devURL(devServerURL, p));
    },
  );

  devTest(
    "initial hard-load page_view has the correct page_title",
    async ({ page, devServerURL }) => {
      await checkInitialPageTitle(page, (p) => devURL(devServerURL, p));
    },
  );

  devTest(
    "soft-nav page_view carries handle metadata + runtime fields",
    async ({ page, devServerURL }) => {
      await checkSoftNavPayload(page, (p) => devURL(devServerURL, p));
    },
  );

  devTest(
    "view_item from loader + add_to_cart on click",
    async ({ page, devServerURL }) => {
      await checkEcommerce(page, (p) => devURL(devServerURL, p));
    },
  );

  devTest(
    "CSP (Report-Only in dev) nonce matches the GTM script nonce",
    async ({ page, devServerURL }) => {
      await checkCspAndNonce(page, (p) => devURL(devServerURL, p), false);
    },
  );

  devTest.describe("no-js", () => {
    devTest.use({ javaScriptEnabled: false });

    devTest(
      "GTM head scripts render without JS",
      async ({ page, devServerURL }) => {
        await checkNoJsHead(page, (p) => devURL(devServerURL, p));
      },
    );
  });
});

// ---------------------------------------------------------------------------
// production
// ---------------------------------------------------------------------------
prodDescribe("gtm", (f) => {
  test("page_view on first render + soft nav", async ({ page }) => {
    await checkFirstRenderAndNav(page, (p) => f.url(p));
  });

  test("initial hard-load page_view has the correct page_title", async ({
    page,
  }) => {
    await checkInitialPageTitle(page, (p) => f.url(p));
  });

  test("soft-nav page_view carries handle metadata + runtime fields", async ({
    page,
  }) => {
    await checkSoftNavPayload(page, (p) => f.url(p));
  });

  test("view_item from loader + add_to_cart on click", async ({ page }) => {
    await checkEcommerce(page, (p) => f.url(p));
  });

  test("CSP (enforced in production) nonce matches the GTM script nonce", async ({
    page,
  }) => {
    await checkCspAndNonce(page, (p) => f.url(p), true);
  });

  test.describe("no-js", () => {
    test.use({ javaScriptEnabled: false });

    test("GTM head scripts render without JS", async ({ page }) => {
      await checkNoJsHead(page, (p) => f.url(p));
    });
  });
});
