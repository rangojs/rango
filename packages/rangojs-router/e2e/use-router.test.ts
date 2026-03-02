import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import {
  waitForHydration,
  expectNoPageError,
  expectNoReload,
  testId,
  goBack,
  waitForNumericChange,
  getNumericContent,
} from "./helper";

// ============================================================================
// useRouter hook - Dev mode
// ============================================================================

test.describe("useRouter", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });

  test("should render test page with router controls", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/hook-tests/use-router"));
    await waitForHydration(page);

    // Page should render
    await expect(testId(page, "use-router-page")).toBeVisible();
    await expect(testId(page, "use-router-title")).toContainText(
      "useRouter Hook Tests",
    );

    // Router test component should be visible
    await expect(testId(page, "use-router-test")).toBeVisible();

    // Loader data should be available
    await expect(testId(page, "router-loader-source")).toContainText(
      "source:server",
    );
  });

  test("push() should navigate to new page and add history entry", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/hook-tests/use-router"));
    await waitForHydration(page);
    await using __ = await expectNoReload(page);

    // Get initial history length
    const initialHistoryLength = await page.evaluate(
      () => window.history.length,
    );

    // Click push button
    await testId(page, "router-push-btn").click();

    // Should navigate to target A
    await expect(testId(page, "router-target-a")).toBeVisible({
      timeout: 5000,
    });
    await expect(testId(page, "target-id")).toContainText("target:a");

    // URL should update
    await expect(page).toHaveURL(/\/hook-tests\/use-router\/target-a/);

    // Navigation status should show the new path
    await expect(testId(page, "nav-status-pathname")).toContainText(
      "path:/hook-tests/use-router/target-a",
    );

    // History length should increase (push adds entry)
    const newHistoryLength = await page.evaluate(() => window.history.length);
    expect(newHistoryLength).toBe(initialHistoryLength + 1);
  });

  test("replace() should navigate without adding history entry", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/hook-tests/use-router"));
    await waitForHydration(page);
    await using __ = await expectNoReload(page);

    // Get initial history length
    const initialHistoryLength = await page.evaluate(
      () => window.history.length,
    );

    // Click replace button
    await testId(page, "router-replace-btn").click();

    // Should navigate to target B
    await expect(testId(page, "router-target-b")).toBeVisible({
      timeout: 5000,
    });
    await expect(testId(page, "target-id")).toContainText("target:b");

    // URL should update
    await expect(page).toHaveURL(/\/hook-tests\/use-router\/target-b/);

    // History length should NOT increase (replace doesn't add entry)
    const newHistoryLength = await page.evaluate(() => window.history.length);
    expect(newHistoryLength).toBe(initialHistoryLength);
  });

  test("refresh() should re-fetch server data without navigation", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/hook-tests/use-router"));
    await waitForHydration(page);

    // Get initial loader count
    const initialCount = await getNumericContent(
      testId(page, "router-loader-count"),
    );

    // Click refresh
    await testId(page, "router-refresh-btn").click();

    // Loader count should increment (server re-executed the loader)
    await waitForNumericChange(
      testId(page, "router-loader-count"),
      initialCount,
    );

    const newCount = await getNumericContent(
      testId(page, "router-loader-count"),
    );
    expect(newCount).toBeGreaterThan(initialCount);

    // URL should remain the same
    await expect(page).toHaveURL(/\/hook-tests\/use-router$/);

    // Navigation status pathname should remain the same
    await expect(testId(page, "nav-status-pathname")).toContainText(
      "path:/hook-tests/use-router",
    );
  });

  test("prefetch() should issue a fetch request with prefetch headers", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/hook-tests/use-router"));
    await waitForHydration(page);

    // Listen for the prefetch fetch request
    const prefetchPromise = page.waitForRequest((req) =>
      req.url().includes("/hook-tests/use-router/target-a") &&
      req.url().includes("_rsc_partial=true"),
    );

    // Click prefetch button
    await testId(page, "router-prefetch-btn").click();

    // State should update
    await expect(testId(page, "router-prefetched-url")).toContainText(
      "prefetched:/hook-tests/use-router/target-a",
    );

    // Should issue a fetch() request with prefetch headers
    const prefetchReq = await prefetchPromise;
    expect(prefetchReq.url()).toContain("_rsc_partial=true");
    const headers = await prefetchReq.allHeaders();
    expect(headers["x-rango-state"]).toBeTruthy();
    expect(headers["x-rango-prefetch"]).toBe("1");
  });

  test("back() should go back in browser history", async ({ page }) => {
    using _ = expectNoPageError(page);

    // Navigate to router test page
    await page.goto(f.url("/hook-tests/use-router"));
    await waitForHydration(page);

    // Push to target A
    await testId(page, "router-push-btn").click();
    await expect(testId(page, "router-target-a")).toBeVisible({
      timeout: 5000,
    });

    // Click back button on target page
    await testId(page, "target-back-btn").click();

    // Should go back to the router test page
    await expect(testId(page, "use-router-page")).toBeVisible({
      timeout: 5000,
    });
    await expect(page).toHaveURL(/\/hook-tests\/use-router$/);
  });

  test("forward() should go forward in browser history", async ({ page }) => {
    using _ = expectNoPageError(page);

    // Navigate to router test page
    await page.goto(f.url("/hook-tests/use-router"));
    await waitForHydration(page);

    // Push to target A
    await testId(page, "router-push-btn").click();
    await expect(testId(page, "router-target-a")).toBeVisible({
      timeout: 5000,
    });

    // Go back using browser history
    await goBack(page);
    await expect(testId(page, "use-router-page")).toBeVisible({
      timeout: 5000,
    });

    // Click forward button
    await testId(page, "router-forward-btn").click();

    // Should go forward to target A
    await expect(testId(page, "router-target-a")).toBeVisible({
      timeout: 5000,
    });
    await expect(page).toHaveURL(/\/hook-tests\/use-router\/target-a/);
  });

  test("useRouter reference should be stable across renders", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/hook-tests/use-router"));
    await waitForHydration(page);

    // Initial render: reference should be stable
    await expect(testId(page, "router-ref-stable")).toContainText(
      "ref-stable:true",
    );

    // Trigger a re-render via refresh (state changes)
    await testId(page, "router-refresh-btn").click();

    // Wait for loader count to change (re-render happened)
    const initialCount = await getNumericContent(
      testId(page, "router-loader-count"),
    );
    await waitForNumericChange(
      testId(page, "router-loader-count"),
      initialCount,
    );

    // Reference should still be stable after re-render
    await expect(testId(page, "router-ref-stable")).toContainText(
      "ref-stable:true",
    );
  });

  test("push then back then forward should preserve history stack", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/hook-tests/use-router"));
    await waitForHydration(page);
    await using __ = await expectNoReload(page);

    // Push to target A
    await testId(page, "router-push-btn").click();
    await expect(testId(page, "router-target-a")).toBeVisible({
      timeout: 5000,
    });

    // Push back to router page via push button on target
    await testId(page, "target-push-back-btn").click();
    await expect(testId(page, "use-router-page")).toBeVisible({
      timeout: 5000,
    });

    // Replace to target B
    await testId(page, "router-replace-btn").click();
    await expect(testId(page, "router-target-b")).toBeVisible({
      timeout: 5000,
    });

    // Go back — should go to target A (replace didn't add entry, so back skips B's replaced entry)
    await testId(page, "target-back-btn").click();
    await expect(testId(page, "router-target-a")).toBeVisible({
      timeout: 5000,
    });
  });
});

// ============================================================================
// useNavigation (state-only) - Dev mode
// ============================================================================

test.describe("useNavigation state-only API", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });

  test("should expose state properties but not navigate/refresh methods", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/hook-tests/use-router"));
    await waitForHydration(page);

    // State properties should exist
    await expect(testId(page, "nav-has-state")).toContainText("has-state:true");
    await expect(testId(page, "nav-has-location")).toContainText(
      "has-location:true",
    );
    await expect(testId(page, "nav-has-streaming")).toContainText(
      "has-streaming:true",
    );

    // Methods should NOT be on navigation return value
    await expect(testId(page, "nav-has-navigate")).toContainText(
      "has-navigate:false",
    );
    await expect(testId(page, "nav-has-refresh")).toContainText(
      "has-refresh:false",
    );

    // State should show current values
    await expect(testId(page, "nav-current-state")).toContainText(
      "nav-state:idle",
    );
    await expect(testId(page, "nav-current-pathname")).toContainText(
      "nav-path:/hook-tests/use-router",
    );
  });

  test("useNavigation should still reflect state during router.push navigation", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/hook-tests/use-router"));
    await waitForHydration(page);

    // Initial state should be idle
    await expect(testId(page, "nav-current-state")).toContainText(
      "nav-state:idle",
    );

    // Push to target A (triggers navigation state change)
    await testId(page, "router-push-btn").click();

    // After navigation completes, state should return to idle
    await expect(testId(page, "router-target-a")).toBeVisible({
      timeout: 5000,
    });
    await expect(testId(page, "nav-status-state")).toContainText("state:idle", {
      timeout: 2000,
    });
  });
});

// ============================================================================
// useRouter hook - Production mode
// ============================================================================

test.describe("useRouter (production)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "build",
  });

  test.setTimeout(120000);

  test("should render test page with router controls", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/hook-tests/use-router"));
    await waitForHydration(page);

    await expect(testId(page, "use-router-page")).toBeVisible();
    await expect(testId(page, "use-router-title")).toContainText(
      "useRouter Hook Tests",
    );
    await expect(testId(page, "router-loader-source")).toContainText(
      "source:server",
    );
  });

  test("push() should navigate and add history entry", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/hook-tests/use-router"));
    await waitForHydration(page);
    await using __ = await expectNoReload(page);

    const initialHistoryLength = await page.evaluate(
      () => window.history.length,
    );

    await testId(page, "router-push-btn").click();

    await expect(testId(page, "router-target-a")).toBeVisible({
      timeout: 5000,
    });
    await expect(testId(page, "target-id")).toContainText("target:a");
    await expect(page).toHaveURL(/\/hook-tests\/use-router\/target-a/);

    const newHistoryLength = await page.evaluate(() => window.history.length);
    expect(newHistoryLength).toBe(initialHistoryLength + 1);
  });

  test("replace() should navigate without adding history entry", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/hook-tests/use-router"));
    await waitForHydration(page);
    await using __ = await expectNoReload(page);

    const initialHistoryLength = await page.evaluate(
      () => window.history.length,
    );

    await testId(page, "router-replace-btn").click();

    await expect(testId(page, "router-target-b")).toBeVisible({
      timeout: 5000,
    });
    await expect(testId(page, "target-id")).toContainText("target:b");
    await expect(page).toHaveURL(/\/hook-tests\/use-router\/target-b/);

    const newHistoryLength = await page.evaluate(() => window.history.length);
    expect(newHistoryLength).toBe(initialHistoryLength);
  });

  test("refresh() should re-fetch server data without navigation", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/hook-tests/use-router"));
    await waitForHydration(page);

    const initialCount = await getNumericContent(
      testId(page, "router-loader-count"),
    );

    await testId(page, "router-refresh-btn").click();

    await waitForNumericChange(
      testId(page, "router-loader-count"),
      initialCount,
    );

    const newCount = await getNumericContent(
      testId(page, "router-loader-count"),
    );
    expect(newCount).toBeGreaterThan(initialCount);

    await expect(page).toHaveURL(/\/hook-tests\/use-router$/);
  });

  test("prefetch() should issue a fetch request with prefetch headers", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/hook-tests/use-router"));
    await waitForHydration(page);

    const prefetchPromise = page.waitForRequest((req) =>
      req.url().includes("/hook-tests/use-router/target-a") &&
      req.url().includes("_rsc_partial=true"),
    );

    await testId(page, "router-prefetch-btn").click();

    await expect(testId(page, "router-prefetched-url")).toContainText(
      "prefetched:/hook-tests/use-router/target-a",
    );

    const prefetchReq = await prefetchPromise;
    expect(prefetchReq.url()).toContain("_rsc_partial=true");
    const headers = await prefetchReq.allHeaders();
    expect(headers["x-rango-state"]).toBeTruthy();
    expect(headers["x-rango-prefetch"]).toBe("1");
  });

  test("back() and forward() should work with browser history", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/hook-tests/use-router"));
    await waitForHydration(page);

    // Push to target A
    await testId(page, "router-push-btn").click();
    await expect(testId(page, "router-target-a")).toBeVisible({
      timeout: 5000,
    });

    // Back
    await testId(page, "target-back-btn").click();
    await expect(testId(page, "use-router-page")).toBeVisible({
      timeout: 5000,
    });
    await expect(page).toHaveURL(/\/hook-tests\/use-router$/);

    // Forward
    await testId(page, "router-forward-btn").click();
    await expect(testId(page, "router-target-a")).toBeVisible({
      timeout: 5000,
    });
    await expect(page).toHaveURL(/\/hook-tests\/use-router\/target-a/);
  });

  test("useRouter reference should be stable across renders", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/hook-tests/use-router"));
    await waitForHydration(page);

    await expect(testId(page, "router-ref-stable")).toContainText(
      "ref-stable:true",
    );

    // Trigger re-render via refresh (read count before clicking)
    const initialCount = await getNumericContent(
      testId(page, "router-loader-count"),
    );
    await testId(page, "router-refresh-btn").click();
    await waitForNumericChange(
      testId(page, "router-loader-count"),
      initialCount,
    );

    await expect(testId(page, "router-ref-stable")).toContainText(
      "ref-stable:true",
    );
  });
});

// ============================================================================
// useNavigation state-only API - Production mode
// ============================================================================

test.describe("useNavigation state-only API (production)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "build",
  });

  test.setTimeout(120000);

  test("should expose state properties but not navigate/refresh methods", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/hook-tests/use-router"));
    await waitForHydration(page);

    // State properties should exist
    await expect(testId(page, "nav-has-state")).toContainText("has-state:true");
    await expect(testId(page, "nav-has-location")).toContainText(
      "has-location:true",
    );
    await expect(testId(page, "nav-has-streaming")).toContainText(
      "has-streaming:true",
    );

    // Methods should NOT be on navigation return value
    await expect(testId(page, "nav-has-navigate")).toContainText(
      "has-navigate:false",
    );
    await expect(testId(page, "nav-has-refresh")).toContainText(
      "has-refresh:false",
    );
  });

  test("useNavigation should still reflect state during router.push navigation", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/hook-tests/use-router"));
    await waitForHydration(page);

    // Initial state should be idle
    await expect(testId(page, "nav-current-state")).toContainText(
      "nav-state:idle",
    );

    // Push to target A (triggers navigation state change)
    await testId(page, "router-push-btn").click();

    // After navigation completes, state should return to idle
    await expect(testId(page, "router-target-a")).toBeVisible({
      timeout: 5000,
    });
    await expect(testId(page, "nav-status-state")).toContainText("state:idle", {
      timeout: 2000,
    });
  });
});
