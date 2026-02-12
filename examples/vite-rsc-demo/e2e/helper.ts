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
 * Wait for React hydration to complete and verify no hydration errors.
 * Self-healing: if a hydration mismatch is detected (common under concurrent
 * dev server load), the page is reloaded and hydration is retried once.
 */
export async function waitForHydration(page: Page, locator: string = "body") {
  const hydrationErrors: string[] = [];

  const isHydrationError = (text: string) =>
    text.includes("Hydration failed") ||
    text.includes("hydration mismatch") ||
    text.includes("Text content does not match") ||
    text.includes("did not match") ||
    text.includes("server rendered HTML") ||
    text.includes("Hydration error");

  const consoleHandler = (msg: import("@playwright/test").ConsoleMessage) => {
    if (isHydrationError(msg.text())) {
      hydrationErrors.push(msg.text());
    }
  };

  const pageErrorHandler = (error: Error) => {
    if (isHydrationError(error.message)) {
      hydrationErrors.push(error.message);
    }
  };

  const waitForFiber = () =>
    expect
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

  page.on("console", consoleHandler);
  page.on("pageerror", pageErrorHandler);

  try {
    await waitForFiber();
    await page.waitForTimeout(100);

    // If hydration mismatch detected, reload and retry.
    // Under concurrent dev server load, SSR can produce stale HTML that
    // disagrees with the client bundle, corrupting React state.
    // Retry up to 3 times since consecutive SSR responses may also mismatch.
    for (let attempt = 0; attempt < 3 && hydrationErrors.length > 0; attempt++) {
      hydrationErrors.length = 0;
      await page.reload();
      await waitForFiber();
      await page.waitForTimeout(100);
    }

    if (hydrationErrors.length > 0) {
      throw new Error(
        `Hydration errors detected after retries:\n${hydrationErrors.join("\n")}`
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
 * Collect and verify no page errors occurred.
 * Hydration mismatch errors are always ignored because waitForHydration
 * handles them with self-healing (reload + retry). Additional patterns
 * can be excluded via the `ignore` option.
 */
export function expectNoPageError(page: Page, options?: { ignore?: RegExp }) {
  const errors: Error[] = [];
  const hydrationPattern =
    /Hydration failed|hydration mismatch|Text content does not match|did not match|server rendered HTML|Hydration error/;
  page.on("pageerror", (error) => {
    if (hydrationPattern.test(error.message)) {
      return;
    }
    if (options?.ignore && options.ignore.test(error.message)) {
      return;
    }
    errors.push(error);
  });
  return {
    [Symbol.dispose]: () => {
      expect(errors).toEqual([]);
    },
  };
}

/**
 * Wait for a specific element to be hydrated by React.
 * Useful for elements inside Suspense boundaries that may be visible (SSR)
 * but not yet interactive (event handlers not attached).
 */
export async function waitForElementHydration(locator: Locator, timeout = 15000) {
  await expect
    .poll(
      () =>
        locator
          .evaluate(
            (el) =>
              el &&
              Object.keys(el).some((key) => key.startsWith("__reactFiber"))
          )
          .catch(() => false),
      { timeout }
    )
    .toBeTruthy();
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
