import { expect, test, type Page } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration } from "./helper";

/**
 * Rango-state invalidation lifecycle tests.
 *
 * Verifies the full cycle:
 *   1. App initializes rango-state in localStorage
 *   2. Server action triggers invalidateRangoState() (timestamp rotation)
 *   3. Subsequent navigation sends the rotated X-Rango-State header
 *
 * This ensures that after a mutation, previously cached prefetch responses
 * (keyed by the old X-Rango-State via Vary) will miss, forcing fresh data.
 */

// rango-state is stored under a per-router namespaced localStorage key
// (`rango-state:{routerId}`) so sibling apps on the same origin don't
// collide. Legacy single-app setups still use the unnamespaced key. The
// helper locates whichever key the app wrote.
async function readRangoState(page: Page): Promise<string | null> {
  return await page.evaluate(() => {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key === "rango-state" || key?.startsWith("rango-state:")) {
        return localStorage.getItem(key);
      }
    }
    return null;
  });
}

async function testRangoStateRotatesAfterAction(
  page: Page,
  url: (path: string) => string,
) {
  // Load a page with a server action button
  await page.goto(url("/loader-cookie/action-sets-cookie"));
  await waitForHydration(page);

  // Read the initial rango-state from localStorage
  const initialState = await readRangoState(page);
  expect(initialState).toBeTruthy();
  const [initialVersion, initialTimestamp] = initialState!.split(":");
  expect(initialVersion).toBeTruthy();
  expect(initialTimestamp).toBeTruthy();

  // Click the server action button — this triggers:
  //   actionSetSessionCookie() → server action bridge → markCacheAsStaleAndBroadcast()
  //   → clearPrefetchCache() → invalidateRangoState() → localStorage update
  await page.click('[data-testid="action-set-cookie-btn"]');

  // Wait for the action to complete (button text changes back from "Setting...")
  await page.waitForSelector(
    '[data-testid="action-set-cookie-btn"]:not([disabled])',
  );

  // Read the rotated rango-state
  const rotatedState = await readRangoState(page);
  expect(rotatedState).toBeTruthy();
  const [rotatedVersion, rotatedTimestamp] = rotatedState!.split(":");

  // Version prefix must be preserved (same build), timestamp must differ
  expect(rotatedVersion).toBe(initialVersion);
  expect(rotatedTimestamp).not.toBe(initialTimestamp);
  expect(Number(rotatedTimestamp)).toBeGreaterThan(Number(initialTimestamp));

  // Set up request listener to capture the X-Rango-State header on next navigation
  const headerPromise = new Promise<string | null>((resolve) => {
    page.on("request", (req) => {
      if (req.url().includes("_rsc_partial")) {
        resolve(req.headerValue("x-rango-state"));
      }
    });
  });

  // Trigger a client-side SPA navigation (Home link in root layout)
  await page.click('[data-testid="nav-home"]');

  // Verify the navigation request sent the rotated state, not the initial one
  const sentHeader = await headerPromise;
  expect(sentHeader).toBe(rotatedState);
  expect(sentHeader).not.toBe(initialState);
}

async function testRangoStateSurvivesRefresh(
  page: Page,
  url: (path: string) => string,
) {
  await page.goto(url("/"));
  await waitForHydration(page);

  const initialState = await readRangoState(page);
  expect(initialState).toBeTruthy();

  // Full page refresh
  await page.reload();
  await waitForHydration(page);

  // rango-state should be preserved (same version prefix → kept by initRangoState)
  const afterRefresh = await readRangoState(page);
  expect(afterRefresh).toBe(initialState);
}

async function testInvalidatedStateSurvivesRefresh(
  page: Page,
  url: (path: string) => string,
) {
  await page.goto(url("/loader-cookie/action-sets-cookie"));
  await waitForHydration(page);

  const initialState = await readRangoState(page);

  // Trigger action to rotate the state
  await page.click('[data-testid="action-set-cookie-btn"]');
  await page.waitForSelector(
    '[data-testid="action-set-cookie-btn"]:not([disabled])',
  );

  const rotatedState = await readRangoState(page);
  expect(rotatedState).not.toBe(initialState);

  // Refresh the page — rotated state should survive (same version prefix)
  await page.reload();
  await waitForHydration(page);

  const afterRefresh = await readRangoState(page);
  expect(afterRefresh).toBe(rotatedState);

  // Navigation after refresh should still use the rotated state
  const headerPromise = new Promise<string | null>((resolve) => {
    page.on("request", (req) => {
      if (req.url().includes("_rsc_partial")) {
        resolve(req.headerValue("x-rango-state"));
      }
    });
  });

  await page.click('[data-testid="nav-home"]');
  const sentHeader = await headerPromise;
  expect(sentHeader).toBe(rotatedState);
}

test.describe("rango-state invalidation lifecycle (dev)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });

  test("server action rotates rango-state and navigation uses rotated value", async ({
    page,
  }) => {
    await testRangoStateRotatesAfterAction(page, f.url);
  });

  test("rango-state survives page refresh", async ({ page }) => {
    await testRangoStateSurvivesRefresh(page, f.url);
  });

  test("invalidated rango-state survives refresh and is used on next navigation", async ({
    page,
  }) => {
    await testInvalidatedStateSurvivesRefresh(page, f.url);
  });
});

test.describe("rango-state invalidation lifecycle (production)", () => {
  test.setTimeout(120000);

  const f = useFixture({
    root: "./e2e/test-app",
    mode: "build",
  });

  test("server action rotates rango-state and navigation uses rotated value", async ({
    page,
  }) => {
    await testRangoStateRotatesAfterAction(page, f.url);
  });

  test("rango-state survives page refresh", async ({ page }) => {
    await testRangoStateSurvivesRefresh(page, f.url);
  });

  test("invalidated rango-state survives refresh and is used on next navigation", async ({
    page,
  }) => {
    await testInvalidatedStateSurvivesRefresh(page, f.url);
  });
});
