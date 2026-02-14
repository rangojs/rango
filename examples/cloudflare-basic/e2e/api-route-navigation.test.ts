import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import {
  waitForHydration,
  expectNoPageError,
  testId,
} from "./helper";

test.describe("api route back navigation", () => {
  const f = useFixture({
    root: ".",
    mode: "dev",
  });

  test("clicking api route link sets navigation to loading state", async ({
    page,
  }) => {
    // Intercept the RSC partial request so we can observe loading state.
    // Without interception, the X-RSC-Reload -> window.location.href happens
    // too fast to observe.
    let resolveRsc: () => void;
    const rscHeld = new Promise<void>((r) => (resolveRsc = r));

    await page.route("**/api/health?_rsc_partial=*", async (route) => {
      // Hold the request - don't respond yet
      await rscHeld;
      await route.continue();
    });

    await page.goto(f.url("/"));
    await waitForHydration(page);
    await expect(testId(page, "home-page")).toBeVisible();

    // Click the link - this starts RSC navigation, setting state to "loading"
    await testId(page, "nav-api-health").click();

    // The navigation state is now "loading" because the RSC fetch is in-flight.
    // Wait for the spin-delay (400ms) to potentially show the indicator.
    await page.waitForTimeout(500);

    // The loading progress bar should be visible since nav state is "loading"
    const progressBar = page.locator(
      'div[style*="position: fixed"][style*="height: 3px"]'
    );
    await expect(progressBar).toBeVisible({ timeout: 2000 });

    // Release the RSC request so the test can clean up
    resolveRsc!();
  });

  test("stale loading state from bfcache restore is cleared by pageshow handler", async ({
    page,
  }) => {
    // This test simulates what happens when bfcache restores a page
    // that was in "loading" state (the X-RSC-Reload scenario).
    //
    // In real browsers: navigate() sets state to "loading", then
    // window.location.href triggers hard nav. bfcache restores the page
    // with stale "loading" state. The pageshow handler should clear it.
    //
    // In Playwright: bfcache doesn't reliably trigger, so we simulate
    // the same scenario by holding the RSC request to keep loading state,
    // then dispatching a pageshow event with persisted=true.

    let resolveRsc: () => void;
    const rscHeld = new Promise<void>((r) => (resolveRsc = r));

    await page.route("**/api/health?_rsc_partial=*", async (route) => {
      await rscHeld;
      // Respond with X-RSC-Reload header (what the server does for response routes)
      await route.fulfill({
        status: 200,
        headers: {
          "X-RSC-Reload": f.url("/api/health"),
        },
        body: "",
      });
    });

    await page.goto(f.url("/"));
    await waitForHydration(page);

    // Click the API link - starts RSC navigation, state = "loading"
    await testId(page, "nav-api-health").click();

    // Wait for loading state to be active
    await page.waitForTimeout(500);
    const progressBar = page.locator(
      'div[style*="position: fixed"][style*="height: 3px"]'
    );
    await expect(progressBar).toBeVisible({ timeout: 2000 });

    // Now simulate bfcache restore by dispatching pageshow with persisted=true.
    // This is what the browser does when restoring from bfcache.
    // The pageshow handler in the navigation bridge should abort the stale
    // navigation and reset state to idle.
    await page.evaluate(() => {
      const event = new PageTransitionEvent("pageshow", { persisted: true });
      window.dispatchEvent(event);
    });

    // After the pageshow handler fires, the loading state should be cleared
    await page.waitForTimeout(200);
    await expect(progressBar).not.toBeVisible({ timeout: 2000 });

    // Release the held request for cleanup
    resolveRsc!();
  });

  test("navigation state should be idle after returning from api route", async ({
    page,
  }) => {
    await page.goto(f.url("/"));
    await waitForHydration(page);

    // Click api-health link
    await testId(page, "nav-api-health").click();
    await page.waitForURL(/\/api\/health/);
    await page.waitForLoadState("networkidle");

    // Go back
    await page.goBack();
    await page.waitForURL(f.url("/"));
    await page.waitForLoadState("domcontentloaded");
    await waitForHydration(page);
    await page.waitForTimeout(600);

    // Check navigation state is idle
    const progressBar = page.locator(
      'div[style*="position: fixed"][style*="height: 3px"]'
    );
    const isLoading = await progressBar.isVisible().catch(() => false);
    expect(isLoading).toBe(false);

    // SPA navigation should still work (not stuck in loading)
    await testId(page, "nav-about").click();
    await expect(testId(page, "about-page")).toBeVisible();
  });

  test("back from api route with prior history should land on correct page", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/"));
    await waitForHydration(page);

    // Build history: home -> about
    await testId(page, "nav-about").click();
    await expect(testId(page, "about-page")).toBeVisible();

    // From about, go to api route
    await testId(page, "nav-api-health").click();
    await page.waitForURL(/\/api\/health/);
    await page.waitForLoadState("networkidle");

    // Back should go to /about
    await page.goBack();
    await page.waitForLoadState("networkidle");
    expect(page.url()).toContain("/about");

    // Back again to home
    await page.goBack();
    await page.waitForLoadState("networkidle");
    expect(page.url()).toBe(f.url("/"));
  });
});
