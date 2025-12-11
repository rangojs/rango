import test, { type Page, expect } from "@playwright/test";

export const testNoJs = test.extend({
  javaScriptEnabled: ({}, use) => use(false),
});

/**
 * Wait for React hydration to complete
 */
export async function waitForHydration(page: Page, locator: string = "body") {
  await expect
    .poll(
      () =>
        page
          .locator(locator)
          .evaluate(
            (el) =>
              el &&
              Object.keys(el).some((key) => key.startsWith("__reactFiber"))
          ),
      { timeout: 20000 }
    )
    .toBeTruthy();
}

/**
 * Verify that no page reload occurred during a test
 */
export async function expectNoReload(page: Page) {
  // Inject custom meta tag to detect reload
  await page.evaluate(() => {
    const el = document.createElement("meta");
    el.setAttribute("name", "x-reload-check");
    document.head.append(el);
  });

  return {
    [Symbol.asyncDispose]: async () => {
      // Check if meta is preserved (no reload)
      await expect(page.locator(`meta[name="x-reload-check"]`)).toBeAttached({
        timeout: 1,
      });
      await page.evaluate(() => {
        document.querySelector(`meta[name="x-reload-check"]`)!.remove();
      });
    },
  };
}

/**
 * Collect and verify no page errors occurred
 */
export function expectNoPageError(page: Page) {
  const errors: Error[] = [];
  page.on("pageerror", (error) => {
    errors.push(error);
  });
  return {
    [Symbol.dispose]: () => {
      expect(errors).toEqual([]);
    },
  };
}

/**
 * Wait for navigation to complete (URL change + network idle)
 */
export async function waitForNavigation(page: Page, expectedUrl: string | RegExp) {
  await page.waitForURL(expectedUrl, { waitUntil: "networkidle" });
}

/**
 * Check if an element is visible in the viewport
 */
export async function isVisibleInViewport(page: Page, selector: string): Promise<boolean> {
  return page.locator(selector).isVisible();
}

/**
 * Wait for an element to appear and be stable
 */
export async function waitForElement(page: Page, selector: string, timeout = 5000) {
  await page.locator(selector).waitFor({ state: "visible", timeout });
}

/**
 * Get the current history state
 */
export async function getHistoryState(page: Page) {
  return page.evaluate(() => window.history.state);
}

/**
 * Navigate back and wait for navigation to complete
 */
export async function goBack(page: Page) {
  await Promise.all([
    page.waitForURL(/.*/, { waitUntil: "networkidle" }),
    page.goBack(),
  ]);
}

/**
 * Navigate forward and wait for navigation to complete
 */
export async function goForward(page: Page) {
  await Promise.all([
    page.waitForURL(/.*/, { waitUntil: "networkidle" }),
    page.goForward(),
  ]);
}
