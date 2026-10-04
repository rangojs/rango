import { expect, test, type Page } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, isPrefetchRequest, blockPrefetch } from "./helper";

/**
 * Rango-state invalidation lifecycle tests.
 *
 * Verifies the full cycle:
 *   1. App initializes the rango state session cookie
 *   2. Server action triggers invalidateRangoState() (timestamp rotation)
 *   3. Subsequent navigation sends the rotated X-Rango-State header
 *
 * This ensures that after a mutation, previously cached prefetch responses
 * (keyed by the old X-Rango-State via Vary) will miss, forcing fresh data.
 */

// rango state lives in a session cookie named `{prefix}_{routerId}` (default
// prefix `rango-state`, or the bare default when metadata lacks the name) so
// sibling apps on the same origin don't collide. The helper locates whichever
// `rango-state...` cookie the app wrote and returns its `{version}:{timestamp}`
// value.
async function readRangoState(page: Page): Promise<string | null> {
  return await page.evaluate(() => {
    for (const part of document.cookie.split(";")) {
      const trimmed = part.trim();
      if (trimmed.startsWith("rango-state")) {
        const eq = trimmed.indexOf("=");
        return eq >= 0 ? trimmed.slice(eq + 1) : null;
      }
    }
    return null;
  });
}

async function testRangoStateRotatesAfterAction(
  page: Page,
  url: (path: string) => string,
) {
  // A post-action viewport prefetch (default-on, re-keyed under the rotated
  // state) of the bare nav-home Link would be adopted by the click below —
  // zero navigation requests and the header waiter would starve. Keep the
  // navigation fetch live.
  await blockPrefetch(page);

  // Load a page with a server action button
  await page.goto(url("/loader-cookie/action-sets-cookie"));
  await waitForHydration(page);

  // Read the initial rango-state from the cookie
  const initialState = await readRangoState(page);
  expect(initialState).toBeTruthy();
  const [initialVersion, initialTimestamp] = initialState!.split(":");
  expect(initialVersion).toBeTruthy();
  expect(initialTimestamp).toBeTruthy();

  // Click the server action button — this triggers:
  //   actionSetSessionCookie() → server action bridge → markCacheAsStaleAndBroadcast()
  //   → clearPrefetchCache() → invalidateRangoState() → cookie rotation
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
      // Skip background viewport prefetches — the waiter must resolve on the
      // NAVIGATION request the click below issues.
      if (req.url().includes("_rsc_partial") && !isPrefetchRequest(req)) {
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
  // Same rationale as testRangoStateRotatesAfterAction: keep the post-refresh
  // click's navigation fetch live so the header waiter sees it.
  await blockPrefetch(page);

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
      // Skip background viewport prefetches — the waiter must resolve on the
      // NAVIGATION request the click below issues.
      if (req.url().includes("_rsc_partial") && !isPrefetchRequest(req)) {
        resolve(req.headerValue("x-rango-state"));
      }
    });
  });

  await page.click('[data-testid="nav-home"]');
  const sentHeader = await headerPromise;
  expect(sentHeader).toBe(rotatedState);
}

async function testKeepCacheLeavesStateUnchanged(
  page: Page,
  url: (path: string) => string,
) {
  await page.goto(url("/loader-cookie/action-sets-cookie"));
  await waitForHydration(page);

  const initialState = await readRangoState(page);
  expect(initialState).toBeTruthy();

  // An action that calls keepClientCache() suppresses the bridge's automatic
  // invalidation, so the rango state value must NOT rotate.
  await page.click('[data-testid="action-keep-cache-btn"]');
  await page.waitForSelector(
    '[data-testid="action-keep-cache-btn"]:not([disabled])',
  );

  const afterState = await readRangoState(page);
  expect(afterState).toBe(initialState);
}

async function testKeepThenInvalidateStillRotates(
  page: Page,
  url: (path: string) => string,
) {
  await page.goto(url("/loader-cookie/action-sets-cookie"));
  await waitForHydration(page);

  const initialState = await readRangoState(page);
  expect(initialState).toBeTruthy();
  const [initialVersion, initialTimestamp] = initialState!.split(":");

  // An action that calls BOTH keepClientCache() and invalidateClientCache():
  // invalidation wins — the explicit Set-Cookie rotates the state even though
  // the automatic path was suppressed.
  await page.click('[data-testid="action-keep-then-invalidate-btn"]');
  await page.waitForSelector(
    '[data-testid="action-keep-then-invalidate-btn"]:not([disabled])',
  );

  const afterState = await readRangoState(page);
  expect(afterState).not.toBe(initialState);
  const [afterVersion, afterTimestamp] = afterState!.split(":");
  expect(afterVersion).toBe(initialVersion);
  expect(Number(afterTimestamp)).toBeGreaterThan(Number(initialTimestamp));
}

async function testClientSeatRotatesState(
  page: Page,
  url: (path: string) => string,
) {
  await page.goto(url("/loader-cookie/action-sets-cookie"));
  await waitForHydration(page);

  const initialState = await readRangoState(page);
  expect(initialState).toBeTruthy();
  const [initialVersion, initialTimestamp] = initialState!.split(":");

  // invalidateClientCache() from browser code (client seat) rotates the state
  // via markCacheAsStaleAndBroadcast -> clearPrefetchCache -> invalidateRangoState.
  await page.click('[data-testid="invalidate-client-btn"]');

  await expect
    .poll(async () => await readRangoState(page))
    .not.toBe(initialState);

  const afterState = await readRangoState(page);
  const [afterVersion, afterTimestamp] = afterState!.split(":");
  expect(afterVersion).toBe(initialVersion);
  expect(Number(afterTimestamp)).toBeGreaterThan(Number(initialTimestamp));
}

async function testCookieClearedMintsFreshAndMisses(
  page: Page,
  url: (path: string) => string,
) {
  await page.goto(url("/loader-cookie/action-sets-cookie"));
  await waitForHydration(page);

  const initialState = await readRangoState(page);
  expect(initialState).toBeTruthy();
  const [initialVersion, initialTimestamp] = initialState!.split(":");

  // A confirming read: navigate once so getRangoState observes the cookie
  // present and marks it cookie-backed. Only then is a later external clear
  // detectable (present -> absent). This mirrors real usage, where the app
  // reads the value on every navigation/prefetch.
  await page.click('[data-testid="nav-home"]');
  await expect(page).toHaveURL(/\/$/);

  // The session cookie is cleared mid-session (the user wipes site data, or a
  // privacy tool drops it). Expire whichever rango-state cookie the app wrote.
  await page.evaluate(() => {
    for (const part of document.cookie.split(";")) {
      const trimmed = part.trim();
      const eq = trimmed.indexOf("=");
      const key = eq >= 0 ? trimmed.slice(0, eq) : trimmed;
      if (key.startsWith("rango-state")) {
        document.cookie = `${key}=; Path=/; Max-Age=0`;
      }
    }
  });

  // The popstate revalidation must fetch the RESTORED route with the freshly
  // minted value (the old Vary key is a miss). Scope to that route's partial
  // request so a stray hover/viewport prefetch can't win the race, and bound the
  // wait so a revalidation regression fails fast instead of hanging the suite.
  const revalidation = page.waitForRequest(
    (req) =>
      req.url().includes("/loader-cookie/action-sets-cookie") &&
      req.url().includes("_rsc_partial"),
    { timeout: 10000 },
  );

  // Back to the prior route. The popstate restore reads getRangoState first,
  // which detects the clear, mints fresh, writes the cookie, and (via the
  // jar-divergence observer) marks the history cache stale -> SWR revalidates.
  await page.goBack();
  await expect(page).toHaveURL(/\/loader-cookie\/action-sets-cookie$/);

  // present -> absent forces a fresh mint: a new value (so every Vary-keyed
  // cache entry misses), the same build version, a strictly newer timestamp.
  const mintedState = await readRangoState(page);
  expect(mintedState).toBeTruthy();
  expect(mintedState).not.toBe(initialState);
  const [mintedVersion, mintedTimestamp] = mintedState!.split(":");
  expect(mintedVersion).toBe(initialVersion);
  expect(Number(mintedTimestamp)).toBeGreaterThan(Number(initialTimestamp));

  // The revalidation carried the minted value, not the cleared one.
  const sentHeader = (await revalidation).headers()["x-rango-state"];
  expect(sentHeader).toBe(mintedState);
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

  test("keepClientCache() leaves the rango-state unchanged", async ({
    page,
  }) => {
    await testKeepCacheLeavesStateUnchanged(page, f.url);
  });

  test("keepClientCache() + invalidateClientCache() still rotates", async ({
    page,
  }) => {
    await testKeepThenInvalidateStillRotates(page, f.url);
  });

  test("invalidateClientCache() client seat rotates the state", async ({
    page,
  }) => {
    await testClientSeatRotatesState(page, f.url);
  });

  test("clearing the rango-state cookie mid-session mints fresh and misses", async ({
    page,
  }) => {
    await testCookieClearedMintsFreshAndMisses(page, f.url);
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

  test("keepClientCache() leaves the rango-state unchanged", async ({
    page,
  }) => {
    await testKeepCacheLeavesStateUnchanged(page, f.url);
  });

  test("keepClientCache() + invalidateClientCache() still rotates", async ({
    page,
  }) => {
    await testKeepThenInvalidateStillRotates(page, f.url);
  });

  test("invalidateClientCache() client seat rotates the state", async ({
    page,
  }) => {
    await testClientSeatRotatesState(page, f.url);
  });

  test("clearing the rango-state cookie mid-session mints fresh and misses", async ({
    page,
  }) => {
    await testCookieClearedMintsFreshAndMisses(page, f.url);
  });
});
