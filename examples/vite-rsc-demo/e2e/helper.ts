import test, { type Page, type Locator, expect } from "@playwright/test";

/**
 * Clear the shopping cart by clicking the clear cart button if it exists.
 * This is useful for test isolation to ensure cart starts empty.
 */
export async function clearCart(page: Page, shopUrl: string) {
  await page.goto(shopUrl);
  await waitForHydration(page);

  const clearButton = page.locator('[data-testid="clear-cart"]');
  if (await clearButton.isVisible({ timeout: 1000 }).catch(() => false)) {
    await clearButton.click();
    // Wait for revalidation to complete
    await page.waitForTimeout(1000);
    // Verify cart is cleared
    await expect(page.locator('a[href="/shop/cart"]')).toContainText("(0)", { timeout: 5000 });
  }

  // Ensure we're on the shop index page (not cart page from accidental navigation)
  if (!page.url().endsWith("/shop")) {
    await page.goto(shopUrl);
    await waitForHydration(page);
  }
}

export const testNoJs = test.extend({
  javaScriptEnabled: ({}, use) => use(false),
});

/**
 * Wait for React hydration to complete and verify no hydration errors
 */
export async function waitForHydration(page: Page, locator: string = "body") {
  const hydrationErrors: string[] = [];

  // Listen for console messages during hydration
  const consoleHandler = (msg: import("@playwright/test").ConsoleMessage) => {
    const text = msg.text();
    // Catch React hydration mismatch errors from console
    if (
      text.includes("Hydration failed") ||
      text.includes("hydration mismatch") ||
      text.includes("Text content does not match") ||
      text.includes("did not match") ||
      text.includes("server rendered HTML") ||
      text.includes("Hydration error")
    ) {
      hydrationErrors.push(text);
    }
  };

  // Listen for page errors (React throws hydration errors here)
  const pageErrorHandler = (error: Error) => {
    const text = error.message;
    // Catch React hydration mismatch errors from pageerror
    if (
      text.includes("Hydration failed") ||
      text.includes("hydration mismatch") ||
      text.includes("Text content does not match") ||
      text.includes("did not match") ||
      text.includes("server rendered HTML") ||
      text.includes("Hydration error")
    ) {
      hydrationErrors.push(text);
    }
  };

  page.on("console", consoleHandler);
  page.on("pageerror", pageErrorHandler);

  try {
    // Wait for React fiber to be attached (hydration complete)
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

    // Small delay to catch any async hydration errors
    await page.waitForTimeout(100);

    // Assert no hydration errors occurred
    if (hydrationErrors.length > 0) {
      throw new Error(
        `Hydration errors detected:\n${hydrationErrors.join("\n")}`
      );
    }
  } finally {
    page.off("console", consoleHandler);
    page.off("pageerror", pageErrorHandler);
  }
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
 * Navigate back. Uses evaluate to avoid hanging on SPA popstate navigations
 * where Playwright's goBack() waits for a page-level load event that never fires.
 */
export async function goBack(page: Page) {
  await page.evaluate(() => window.history.back());
}

/**
 * Navigate forward. Uses evaluate to avoid hanging on SPA popstate navigations.
 */
export async function goForward(page: Page) {
  await page.evaluate(() => window.history.forward());
}

/**
 * Get a locator by data-testid attribute
 */
export function testId(page: Page, id: string): Locator {
  return page.locator(`[data-testid="${id}"]`);
}

/**
 * Click an element and wait for another element to become visible
 */
export async function clickAndWaitFor(
  clickTarget: Locator,
  waitFor: Locator,
  timeout = 5000
) {
  await clickTarget.click();
  await expect(waitFor).toBeVisible({ timeout });
}

/**
 * Measure elapsed time for an async operation
 */
export async function measureTime<T>(
  fn: () => Promise<T>
): Promise<{ elapsed: number; result: T }> {
  const startTime = Date.now();
  const result = await fn();
  const elapsed = Date.now() - startTime;
  return { elapsed, result };
}

/**
 * Create a stopwatch for timing multiple checkpoints
 */
export function createStopwatch() {
  const startTime = Date.now();
  return {
    elapsed: () => Date.now() - startTime,
    checkpoint: () => {
      const elapsed = Date.now() - startTime;
      return elapsed;
    },
  };
}

/**
 * Parse a number from text content (finds first number in string)
 */
export function parseNumber(text: string | null | undefined): number {
  return parseInt(text?.match(/\d+/)?.[0] || "0", 10);
}

/**
 * Get the numeric value from an element's text content
 */
export async function getNumericContent(locator: Locator): Promise<number> {
  const text = await locator.textContent();
  return parseNumber(text);
}

/**
 * Wait for an element's text to change from its initial value
 */
export async function waitForTextChange(
  locator: Locator,
  initialText: string,
  timeout = 5000
) {
  await expect
    .poll(async () => await locator.textContent(), { timeout })
    .not.toBe(initialText);
}

/**
 * Wait for a numeric value in an element to change
 */
export async function waitForNumericChange(
  locator: Locator,
  initialValue: number,
  timeout = 5000
) {
  await expect
    .poll(async () => parseNumber(await locator.textContent()), { timeout })
    .not.toBe(initialValue);
}

/**
 * Assert timing is within expected range (expected +/- tolerance)
 */
export function expectTiming(
  elapsed: number,
  expected: number,
  tolerance: number
) {
  expect(elapsed).toBeGreaterThan(expected - tolerance);
  expect(elapsed).toBeLessThan(expected + tolerance);
}

/**
 * Assert timing is at least a minimum value
 */
export function expectMinTiming(elapsed: number, minimum: number) {
  expect(elapsed).toBeGreaterThan(minimum);
}

/**
 * Assert timing is less than a maximum value
 */
export function expectMaxTiming(elapsed: number, maximum: number) {
  expect(elapsed).toBeLessThan(maximum);
}
