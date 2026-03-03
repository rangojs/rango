import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError } from "./helper";

/**
 * Link interception and prefetch behavior tests.
 * Covers data-no-intercept, global interceptor, and Link prefetch strategies.
 */
test.describe("link-behavior", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });

  test("data-no-intercept anchor causes full page load", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/link-behavior"));
    await waitForHydration(page);

    await expect(
      page.locator('[data-testid="link-behavior-page"]'),
    ).toBeVisible();

    // Clicking data-no-intercept should trigger a full page load.
    // We detect this by checking that a navigation event fires (new page load).
    const [response] = await Promise.all([
      page.waitForNavigation({ waitUntil: "load" }),
      page.locator('[data-testid="anchor-no-intercept"]').click(),
    ]);

    // Full page load navigated to /blog
    await expect(page).toHaveURL(/\/blog$/);
    // The response indicates a document load, not an SPA navigation
    expect(response).toBeTruthy();
  });

  test("plain anchor without data-no-intercept uses SPA navigation", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/link-behavior"));
    await waitForHydration(page);

    // Inject a marker to detect SPA vs full reload
    await page.evaluate(() => {
      (window as any).__spa_marker = true;
    });

    await page.locator('[data-testid="anchor-intercepted"]').click();
    await expect(page).toHaveURL(/\/blog$/);

    // SPA navigation preserves window state
    const markerSurvived = await page.evaluate(
      () => (window as any).__spa_marker === true,
    );
    expect(markerSurvived).toBe(true);
  });

  test("Link prefetch='hover' sends prefetch request on mouse enter", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/link-behavior"));
    await waitForHydration(page);

    // Listen for prefetch requests
    const prefetchPromise = page.waitForRequest(
      (req) =>
        req.url().includes("/blog") &&
        req.url().includes("_rsc_partial") &&
        req.headers()["x-rango-prefetch"] === "1",
      { timeout: 5000 },
    );

    // Hover over the link to trigger prefetch
    await page.locator('[data-testid="link-prefetch-hover"]').hover();

    const prefetchReq = await prefetchPromise;
    expect(prefetchReq.url()).toContain("_rsc_partial");
    expect(prefetchReq.headers()["x-rango-prefetch"]).toBe("1");
  });

  test("Link prefetch='render' sends prefetch request after hydration", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // Listen for prefetch requests before navigating
    const prefetchPromise = page.waitForRequest(
      (req) =>
        req.url().includes("/blog/post-1") &&
        req.url().includes("_rsc_partial") &&
        req.headers()["x-rango-prefetch"] === "1",
      { timeout: 10000 },
    );

    await page.goto(f.url("/link-behavior"));
    await waitForHydration(page);

    // prefetch="render" should fire after hydration completes
    const prefetchReq = await prefetchPromise;
    expect(prefetchReq.url()).toContain("_rsc_partial");
    expect(prefetchReq.headers()["x-rango-prefetch"]).toBe("1");
  });

  test("Link prefetch='none' does not send prefetch request", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    const prefetchRequests: string[] = [];
    page.on("request", (req) => {
      if (
        req.url().includes("/blog/post-2") &&
        req.url().includes("_rsc_partial")
      ) {
        prefetchRequests.push(req.url());
      }
    });

    await page.goto(f.url("/link-behavior"));
    await waitForHydration(page);

    // Wait a bit to ensure no prefetch fires
    await page.waitForTimeout(2000);

    // Hover over the link (should not trigger prefetch since strategy is "none")
    await page.locator('[data-testid="link-prefetch-none"]').hover();
    await page.waitForTimeout(1000);

    expect(prefetchRequests).toHaveLength(0);
  });

  test("Link prefetch='viewport' sends prefetch when link is visible", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // Link is visible on page load (within 200px rootMargin).
    // IntersectionObserver fires, then waits for idle, then prefetches.
    const prefetchPromise = page.waitForRequest(
      (req) =>
        req.url().includes("/blog/post-3") &&
        req.url().includes("_rsc_partial") &&
        req.headers()["x-rango-prefetch"] === "1",
      { timeout: 10000 },
    );

    await page.goto(f.url("/link-behavior"));
    await waitForHydration(page);

    const prefetchReq = await prefetchPromise;
    expect(prefetchReq.url()).toContain("_rsc_partial");
    expect(prefetchReq.headers()["x-rango-prefetch"]).toBe("1");
  });

  test("Link prefetch='hybrid' uses hover on pointer device", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/link-behavior"));
    await waitForHydration(page);

    // On desktop (pointer device), hybrid resolves to hover.
    // Prefetch should fire on mouse enter, not automatically.
    const prefetchPromise = page.waitForRequest(
      (req) =>
        req.url().includes("/blog/post-4") &&
        req.url().includes("_rsc_partial") &&
        req.headers()["x-rango-prefetch"] === "1",
      { timeout: 5000 },
    );

    await page.locator('[data-testid="link-prefetch-hybrid"]').hover();

    const prefetchReq = await prefetchPromise;
    expect(prefetchReq.url()).toContain("_rsc_partial");
    expect(prefetchReq.headers()["x-rango-prefetch"]).toBe("1");
  });
});

test.describe("link-behavior (production)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "build",
  });

  test("data-no-intercept anchor causes full page load", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/link-behavior"));
    await waitForHydration(page);

    await expect(
      page.locator('[data-testid="link-behavior-page"]'),
    ).toBeVisible();

    const [response] = await Promise.all([
      page.waitForNavigation({ waitUntil: "load" }),
      page.locator('[data-testid="anchor-no-intercept"]').click(),
    ]);

    await expect(page).toHaveURL(/\/blog$/);
    expect(response).toBeTruthy();
  });

  test("plain anchor without data-no-intercept uses SPA navigation", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/link-behavior"));
    await waitForHydration(page);

    await page.evaluate(() => {
      (window as any).__spa_marker = true;
    });

    await page.locator('[data-testid="anchor-intercepted"]').click();
    await expect(page).toHaveURL(/\/blog$/);

    const markerSurvived = await page.evaluate(
      () => (window as any).__spa_marker === true,
    );
    expect(markerSurvived).toBe(true);
  });

  test("Link prefetch='hover' sends prefetch request on mouse enter", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/link-behavior"));
    await waitForHydration(page);

    const prefetchPromise = page.waitForRequest(
      (req) =>
        req.url().includes("/blog") &&
        req.url().includes("_rsc_partial") &&
        req.headers()["x-rango-prefetch"] === "1",
      { timeout: 5000 },
    );

    await page.locator('[data-testid="link-prefetch-hover"]').hover();

    const prefetchReq = await prefetchPromise;
    expect(prefetchReq.url()).toContain("_rsc_partial");
    expect(prefetchReq.headers()["x-rango-prefetch"]).toBe("1");
  });

  test("Link prefetch='render' sends prefetch request after hydration", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    const prefetchPromise = page.waitForRequest(
      (req) =>
        req.url().includes("/blog/post-1") &&
        req.url().includes("_rsc_partial") &&
        req.headers()["x-rango-prefetch"] === "1",
      { timeout: 10000 },
    );

    await page.goto(f.url("/link-behavior"));
    await waitForHydration(page);

    const prefetchReq = await prefetchPromise;
    expect(prefetchReq.url()).toContain("_rsc_partial");
    expect(prefetchReq.headers()["x-rango-prefetch"]).toBe("1");
  });

  test("Link prefetch='none' does not send prefetch request", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    const prefetchRequests: string[] = [];
    page.on("request", (req) => {
      if (
        req.url().includes("/blog/post-2") &&
        req.url().includes("_rsc_partial")
      ) {
        prefetchRequests.push(req.url());
      }
    });

    await page.goto(f.url("/link-behavior"));
    await waitForHydration(page);

    await page.waitForTimeout(2000);

    await page.locator('[data-testid="link-prefetch-none"]').hover();
    await page.waitForTimeout(1000);

    expect(prefetchRequests).toHaveLength(0);
  });

  test("Link prefetch='viewport' sends prefetch when link is visible", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    const prefetchPromise = page.waitForRequest(
      (req) =>
        req.url().includes("/blog/post-3") &&
        req.url().includes("_rsc_partial") &&
        req.headers()["x-rango-prefetch"] === "1",
      { timeout: 10000 },
    );

    await page.goto(f.url("/link-behavior"));
    await waitForHydration(page);

    const prefetchReq = await prefetchPromise;
    expect(prefetchReq.url()).toContain("_rsc_partial");
    expect(prefetchReq.headers()["x-rango-prefetch"]).toBe("1");
  });

  test("Link prefetch='hybrid' uses hover on pointer device", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/link-behavior"));
    await waitForHydration(page);

    const prefetchPromise = page.waitForRequest(
      (req) =>
        req.url().includes("/blog/post-4") &&
        req.url().includes("_rsc_partial") &&
        req.headers()["x-rango-prefetch"] === "1",
      { timeout: 5000 },
    );

    await page.locator('[data-testid="link-prefetch-hybrid"]').hover();

    const prefetchReq = await prefetchPromise;
    expect(prefetchReq.url()).toContain("_rsc_partial");
    expect(prefetchReq.headers()["x-rango-prefetch"]).toBe("1");
  });
});
