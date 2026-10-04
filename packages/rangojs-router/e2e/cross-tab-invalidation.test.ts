import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { useFixture } from "./fixture";
import { isPrefetchRequest, waitForHydration } from "./helper";

/**
 * Cross-tab rango-state invalidation tests.
 *
 * Verifies that when one tab rotates the rango state cookie, other tabs pick up
 * the new value via the shared cookie jar (read per request) and send the
 * updated X-Rango-State header on subsequent navigations.
 */

// rango state lives in a session cookie named `{prefix}_{routerId}` (default
// prefix `rango-state`), shared across tabs in one context. These helpers locate
// the app-specific cookie without hard-coding the router id.
async function findRangoStateCookieName(page: Page): Promise<string> {
  return await page.evaluate(() => {
    for (const part of document.cookie.split(";")) {
      const trimmed = part.trim();
      const eq = trimmed.indexOf("=");
      if (eq > 0 && trimmed.slice(0, eq).startsWith("rango-state")) {
        return trimmed.slice(0, eq);
      }
    }
    return "rango-state";
  });
}

async function readRangoState(page: Page): Promise<string | null> {
  const name = await findRangoStateCookieName(page);
  return await page.evaluate((n) => {
    for (const part of document.cookie.split(";")) {
      const trimmed = part.trim();
      if (trimmed.startsWith(n + "=")) return trimmed.slice(n.length + 1);
    }
    return null;
  }, name);
}

async function testCrossTabInvalidation(
  context: BrowserContext,
  baseUrl: string,
) {
  // Open two pages in the same browser context (shared cookie jar)
  const pageA = await context.newPage();
  const pageB = await context.newPage();
  const pageC = await context.newPage();

  // Both pages load the app and hydrate (binds the shared rango state cookie)
  await pageA.goto(baseUrl);
  await waitForHydration(pageA);
  await pageB.goto(new URL("/link-behavior", baseUrl).href);
  await waitForHydration(pageB);
  await pageC.goto(new URL("/link-behavior", baseUrl).href);
  await waitForHydration(pageC);

  // Read the initial rango-state from the shared cookie jar
  const cookieName = await findRangoStateCookieName(pageA);
  const initialState = await readRangoState(pageA);
  expect(initialState).toBeTruthy();

  // Verify pageB has the same initial state (shared jar)
  const pageBInitialState = await readRangoState(pageB);
  expect(pageBInitialState).toBe(initialState);

  // Warm a real rendered Link under the initial state. Its explicit hover
  // strategy keeps this deterministic in both development and production.
  const link = pageB.getByTestId("link-prefetch-hover");
  const warmResponsePromise = pageB.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === "/blog" && isPrefetchRequest(response.request());
  });
  await link.hover();
  const warmResponse = await warmResponsePromise;
  await warmResponse.finished();
  expect(await warmResponse.request().headerValue("x-rango-state")).toBe(
    initialState,
  );

  // Page A simulates invalidation: rotates the shared rango state cookie. The
  // cookie jar is shared across tabs, so pageB reads the new value on its next
  // fetch (the per-request cookie read IS the cross-tab value sync).
  const newState = `${initialState!.split(":")[0]}:${Date.now() + 999999}`;
  await pageA.evaluate(
    ([name, val]) => {
      document.cookie = `${name}=${val}; Path=/; SameSite=Lax`;
    },
    [cookieName, newState],
  );

  // The write lands in the shared jar; pageB sees it on its next read.
  await pageB.waitForTimeout(100);

  // Verify the cookie is updated in both tabs (shared jar)
  const pageBUpdatedState = await readRangoState(pageB);
  expect(pageBUpdatedState).toBe(newState);

  // The old-state warm entry must not satisfy this click. The state-keyed
  // lookup misses and issues a navigation request with the rotated value.
  const navigationRequestPromise = pageB.waitForRequest((request) => {
    const url = new URL(request.url());
    return (
      url.pathname === "/blog" &&
      url.searchParams.has("_rsc_partial") &&
      !isPrefetchRequest(request)
    );
  });
  await link.focus();
  await pageB.keyboard.press("Enter");

  // Wait for the navigation request and check the header
  const navigationRequest = await navigationRequestPromise;
  const sentHeader = await navigationRequest.headerValue("x-rango-state");
  expect(sentHeader).toBe(newState);

  // A rendered plain anchor takes the delegated-interceptor click path. Keep a
  // unique query so this request cannot reuse pageB's navigation response.
  const delegatedRequestPromise = pageC.waitForRequest((request) => {
    const url = new URL(request.url());
    return (
      url.pathname === "/blog" &&
      url.searchParams.get("cross-tab-delegated") === "1" &&
      url.searchParams.has("_rsc_partial") &&
      !isPrefetchRequest(request)
    );
  });
  await pageC.getByTestId("cross-tab-delegated-navigation").click();
  const delegatedRequest = await delegatedRequestPromise;
  expect(await delegatedRequest.headerValue("x-rango-state")).toBe(newState);

  await pageA.close();
  await pageB.close();
  await pageC.close();
}

test.describe("cross-tab rango-state invalidation (dev)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });

  test("Link and delegated anchors send updated X-Rango-State after pageA invalidates", async ({
    context,
  }) => {
    await testCrossTabInvalidation(context, f.url("/"));
  });
});

test.describe("cross-tab rango-state invalidation (production)", () => {
  test.setTimeout(120000);

  const f = useFixture({
    root: "./e2e/test-app",
    mode: "build",
  });

  test("Link and delegated anchors send updated X-Rango-State after pageA invalidates", async ({
    context,
  }) => {
    await testCrossTabInvalidation(context, f.url("/"));
  });
});
