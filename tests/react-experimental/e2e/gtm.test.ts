import { expect, test, type Page } from "@playwright/test";
import { useFixture, type Fixture } from "./fixture";
import { waitForHydration, expectNoPageError, testId } from "./helper";

/**
 * GTM + CSP nonce regression coverage under React's experimental channel. The
 * surface most likely to differ from stable React: nonce stamping on the
 * hoisted gtm.js loader, hydration of a nonced inline script (suppressed), and
 * head-script ordering. Verifies the scripts render in <head> with the request
 * nonce, hydrate clean, fire page_view on first render + soft nav, and are
 * present in the no-JS server HTML — in both dev and production builds.
 */

type Url = (path: string) => string;

interface DataLayerEvent {
  event?: string;
  page_path?: string;
  [key: string]: unknown;
}

// Head-scoped: matches the gtm.js loader only when it is inside <head>.
const GTM_LOADER = 'head script[src*="googletagmanager.com/gtm.js"]';

async function pageViewPaths(page: Page): Promise<(string | undefined)[]> {
  const dl = await page.evaluate(
    () =>
      (window as unknown as { dataLayer?: DataLayerEvent[] }).dataLayer ?? [],
  );
  return dl.filter((e) => e.event === "page_view").map((e) => e.page_path);
}

// The inline GTM bootstrap is always in <head> (identical with/without JS); the
// gtm.js loader is injected by that script at runtime, so present only with JS.
async function expectGtmInHead(page: Page, loaderInjected: boolean) {
  const headInline = await page
    .locator("head script:not([src])")
    .allTextContents();
  const bootstrap = headInline.find((s) => s.includes("window.dataLayer"));
  expect(bootstrap, "inline GTM bootstrap is in <head>").toBeTruthy();
  expect(bootstrap).toContain("page_view");
  expect(bootstrap).toContain("googletagmanager.com/gtm.js");
  await expect(page.locator(GTM_LOADER)).toHaveCount(loaderInjected ? 1 : 0);
}

async function checkFirstRenderAndNav(page: Page, url: Url) {
  using _ = expectNoPageError(page);

  await page.goto(url("/"));
  await waitForHydration(page);

  await expectGtmInHead(page, true);
  expect(await pageViewPaths(page)).toEqual(["/"]);

  await testId(page, "nav-about").click();
  await expect(testId(page, "about-page")).toBeVisible();

  await expect.poll(() => pageViewPaths(page)).toEqual(["/", "/about"]);
}

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
  const scriptNonces = [...html.matchAll(/<script[^>]*\snonce="([^"]+)"/g)].map(
    (m) => m[1],
  );
  expect(
    scriptNonces,
    "the inline GTM script carries the CSP nonce in the SSR HTML",
  ).toContain(cspNonce);
  expect(html).toContain('event:"page_view"');

  // dataLayer initialised before gtm.js is injected (both in the inline script).
  const initIdx = html.indexOf("window.dataLayer=window.dataLayer||[]");
  const loaderIdx = html.indexOf("googletagmanager.com/gtm.js");
  expect(initIdx).toBeGreaterThanOrEqual(0);
  expect(loaderIdx).toBeGreaterThan(initIdx);

  expect(html.indexOf("googletagmanager")).toBeLessThan(html.indexOf("<body"));
}

// The root layout owns the Script push, so a DIRECT (hard) load of a non-home
// route also gets the bootstrap + its first page_view — not just "/".
async function checkAppWideBootstrap(page: Page, url: Url) {
  using _ = expectNoPageError(page);

  await page.goto(url("/about"));
  await waitForHydration(page);

  await expectGtmInHead(page, true);
  expect(await pageViewPaths(page)).toEqual(["/about"]);
}

async function checkNoJsHead(page: Page, url: Url) {
  await page.goto(url("/"));
  // Bootstrap markup present; loader not injected without JS.
  await expectGtmInHead(page, false);
  await expect(page.locator("noscript")).toBeAttached();
}

function defineSuite(f: Fixture) {
  test("page_view on first render + soft nav", async ({ page }) => {
    await checkFirstRenderAndNav(page, (p) => f.url(p));
  });

  test("CSP nonce matches the GTM script nonce (enforced in production)", async ({
    page,
  }) => {
    await checkCspAndNonce(page, (p) => f.url(p), f.mode === "build");
  });

  test("bootstrap is app-wide (direct load of /about)", async ({ page }) => {
    await checkAppWideBootstrap(page, (p) => f.url(p));
  });

  test.describe("no-js", () => {
    test.use({ javaScriptEnabled: false });
    test("GTM head scripts render without JS", async ({ page }) => {
      await checkNoJsHead(page, (p) => f.url(p));
    });
  });
}

test.describe("gtm (dev)", () => {
  const f = useFixture({ root: ".", mode: "dev" });
  defineSuite(f);
});

test.describe("gtm (production)", () => {
  const f = useFixture({ root: ".", mode: "build" });
  defineSuite(f);
});
