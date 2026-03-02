import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration } from "./helper";

/**
 * Cross-tab rango-state invalidation tests.
 *
 * Verifies that when one tab invalidates the rango-state (via server action),
 * other tabs pick up the new value via the `storage` event and send the
 * updated X-Rango-State header on subsequent navigations.
 */

async function testCrossTabInvalidation(
  context: BrowserContext,
  baseUrl: string,
) {
  // Open two pages in the same browser context (shared localStorage)
  const pageA = await context.newPage();
  const pageB = await context.newPage();

  // Both pages load the app and hydrate (initializes rango-state + storage listener)
  await pageA.goto(baseUrl);
  await waitForHydration(pageA);
  await pageB.goto(baseUrl);
  await waitForHydration(pageB);

  // Read the initial rango-state from localStorage
  const initialState = await pageA.evaluate(() =>
    localStorage.getItem("rango-state"),
  );
  expect(initialState).toBeTruthy();

  // Verify pageB has the same initial state
  const pageBInitialState = await pageB.evaluate(() =>
    localStorage.getItem("rango-state"),
  );
  expect(pageBInitialState).toBe(initialState);

  // Intercept the next partial navigation request from pageB to capture X-Rango-State
  const headerPromise = new Promise<string | null>((resolve) => {
    pageB.on("request", (req) => {
      const header = req.headerValue("x-rango-state");
      if (req.url().includes("_rsc_partial") && header) {
        resolve(header);
      }
    });
  });

  // Page A simulates invalidation: writes a new rango-state to localStorage.
  // This fires the `storage` event in pageB (cross-tab), updating its cachedState.
  const newState = `${initialState!.split(":")[0]}:${Date.now() + 999999}`;
  await pageA.evaluate(
    ([key, val]) => localStorage.setItem(key, val),
    ["rango-state", newState],
  );

  // Small wait to ensure the storage event fires and propagates
  await pageB.waitForTimeout(100);

  // Verify localStorage is updated in both tabs
  const pageBUpdatedState = await pageB.evaluate(() =>
    localStorage.getItem("rango-state"),
  );
  expect(pageBUpdatedState).toBe(newState);

  // Now trigger a client-side navigation in pageB by clicking a link
  await pageB.click('a[href*="/blog"]');

  // Wait for the navigation request and check the header
  const sentHeader = await headerPromise;
  expect(sentHeader).toBe(newState);

  await pageA.close();
  await pageB.close();
}

test.describe("cross-tab rango-state invalidation (dev)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });

  test("pageB sends updated X-Rango-State after pageA invalidates", async ({
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

  test("pageB sends updated X-Rango-State after pageA invalidates", async ({
    context,
  }) => {
    await testCrossTabInvalidation(context, f.url("/"));
  });
});
