import test, {
  type Page,
  type Locator,
  type ConsoleMessage,
  expect,
} from "@playwright/test";

export const testNoJs = test.extend({
  javaScriptEnabled: ({}, use) => use(false),
});

/**
 * Wait for React hydration to complete and verify no hydration errors
 */
export async function waitForHydration(page: Page) {
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
    // Wait for DOM to be ready before checking hydration marker
    await page.waitForLoadState("domcontentloaded");

    // RSCRouter sets data-hydrated on <html> after hydration via useEffect.
    // This is a stable readiness signal that does not rely on React internals.
    await page.waitForFunction(
      () => document.documentElement.hasAttribute("data-hydrated"),
      { timeout: 20000 },
    );

    // Small delay to catch any async hydration errors
    await page.waitForTimeout(100);

    // Assert no hydration errors occurred
    if (hydrationErrors.length > 0) {
      throw new Error(
        `Hydration errors detected:\n${hydrationErrors.join("\n")}`,
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
export async function waitForNavigation(
  page: Page,
  expectedUrl: string | RegExp,
) {
  await page.waitForURL(expectedUrl, { waitUntil: "networkidle" });
}

/**
 * Check if an element is visible in the viewport
 */
export async function isVisibleInViewport(
  page: Page,
  selector: string,
): Promise<boolean> {
  return page.locator(selector).isVisible();
}

/**
 * Wait for an element to appear and be stable
 */
export async function waitForElement(
  page: Page,
  selector: string,
  timeout = 5000,
) {
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
 *
 * @example
 * const button = testId(page, "submit-btn");
 * await button.click();
 *
 * @example
 * await expect(testId(page, "error-message")).toBeVisible();
 */
export function testId(page: Page, id: string): Locator {
  return page.locator(`[data-testid="${id}"]`);
}

/**
 * Click an element and wait for another element to become visible
 *
 * @example
 * await clickAndWaitFor(
 *   testId(page, "product-link"),
 *   testId(page, "product-modal")
 * );
 *
 * @example
 * await clickAndWaitFor(submitBtn, successMessage, 10000);
 */
export async function clickAndWaitFor(
  clickTarget: Locator,
  waitFor: Locator,
  timeout = 5000,
) {
  await clickTarget.click();
  await expect(waitFor).toBeVisible({ timeout });
}

/**
 * Measure elapsed time for an async operation
 * Returns { elapsed, result } where elapsed is in milliseconds
 *
 * @example
 * const { elapsed } = await measureTime(async () => {
 *   await page.goto("/slow-route");
 *   await waitForHydration(page);
 * });
 * expect(elapsed).toBeGreaterThan(1000);
 */
export async function measureTime<T>(
  fn: () => Promise<T>,
): Promise<{ elapsed: number; result: T }> {
  const startTime = Date.now();
  const result = await fn();
  const elapsed = Date.now() - startTime;
  return { elapsed, result };
}

/**
 * Create a stopwatch for timing multiple checkpoints
 *
 * @example
 * const stopwatch = createStopwatch();
 * await button.click();
 * const loadingTime = stopwatch.checkpoint();
 * await expect(content).toBeVisible();
 * const totalTime = stopwatch.elapsed();
 * expect(loadingTime).toBeLessThan(500);
 * expect(totalTime).toBeGreaterThan(1000);
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
 *
 * @example
 * parseNumber("Load count: 42") // returns 42
 * parseNumber("$99.99") // returns 99
 * parseNumber(null) // returns 0
 */
export function parseNumber(text: string | null | undefined): number {
  return parseInt(text?.match(/\d+/)?.[0] || "0", 10);
}

/**
 * Get the numeric value from an element's text content
 *
 * @example
 * const count = await getNumericContent(testId(page, "item-count"));
 * expect(count).toBe(5);
 */
export async function getNumericContent(locator: Locator): Promise<number> {
  const text = await locator.textContent();
  return parseNumber(text);
}

/**
 * Wait for an element's text to change from its initial value
 *
 * @example
 * const initialText = await statusEl.textContent();
 * await triggerUpdate();
 * await waitForTextChange(statusEl, initialText);
 */
export async function waitForTextChange(
  locator: Locator,
  initialText: string,
  timeout = 5000,
) {
  await expect
    .poll(async () => await locator.textContent(), { timeout })
    .not.toBe(initialText);
}

/**
 * Wait for a numeric value in an element to change
 *
 * @example
 * const initialCount = await getNumericContent(countEl);
 * await incrementButton.click();
 * await waitForNumericChange(countEl, initialCount);
 */
export async function waitForNumericChange(
  locator: Locator,
  initialValue: number,
  timeout = 5000,
) {
  await expect
    .poll(async () => parseNumber(await locator.textContent()), { timeout })
    .not.toBe(initialValue);
}

/**
 * Assert timing is within expected range (expected +/- tolerance)
 *
 * @example
 * const stopwatch = createStopwatch();
 * await slowOperation();
 * expectTiming(stopwatch.elapsed(), 1000, 200); // 800-1200ms
 */
export function expectTiming(
  elapsed: number,
  expected: number,
  tolerance: number,
) {
  expect(elapsed).toBeGreaterThan(expected - tolerance);
  expect(elapsed).toBeLessThan(expected + tolerance);
}

/**
 * Assert timing is at least a minimum value
 *
 * @example
 * expectMinTiming(elapsed, 1000); // must take at least 1s
 */
export function expectMinTiming(elapsed: number, minimum: number) {
  expect(elapsed).toBeGreaterThan(minimum);
}

/**
 * Assert timing is less than a maximum value
 *
 * @example
 * expectMaxTiming(loadingVisibleTime, 500); // loading must appear within 500ms
 */
export function expectMaxTiming(elapsed: number, maximum: number) {
  expect(elapsed).toBeLessThan(maximum);
}

// ============================================================================
//  HMR Debugging
// ============================================================================
//
// To debug HMR issues interactively:
//
//   1. Start the test app:  cd e2e/test-app && pnpm dev --port 5188
//   2. Open browser DevTools > Console, filter by "[vite]" to see HMR events
//   3. Edit a file and watch for:
//      - "[vite] hot updated: /path/to/file" = successful HMR (js-update)
//      - "[vite] page reload"               = full reload (something lacked an HMR boundary)
//      - "[vite] connected."                = WebSocket reconnect (server restarted)
//   4. For server-side HMR tracing, check the terminal for:
//      - "[rsc-router] RSC module changed, version updated: ..." = RSC env detected a change
//
// To debug HMR via WebSocket frames (sees raw Vite messages before console):
//   - DevTools > Network > WS tab > select the Vite HMR connection > Messages
//   - Look for JSON frames with "type": "full-reload" vs "type": "update"
//   - "triggeredBy" field shows which file caused the reload
//
// Common issues:
//   - "use client" file triggers full-reload: the client-component-hmr plugin
//     should return [] for RSC/SSR envs. Check if the file actually starts with
//     "use client" (not after imports or comments).
//   - RSC context store unavailable after HMR: the AsyncLocalStorage in
//     context.ts must survive module re-evaluation (uses globalThis singleton).
//   - Multiple HMR updates for one change: check if the vite plugin writes
//     files (e.g., route types) in response to module changes, causing cascading
//     invalidations.
//

export interface HmrEvent {
  type: "js-update" | "full-reload" | "console";
  detail: string;
  timestamp: number;
}

/**
 * Capture Vite HMR events from both console messages and WebSocket frames.
 * Returns a collector with typed event arrays and a dispose method.
 *
 * @example
 * const hmr = await captureHmrEvents(page);
 * fs.writeFileSync(filePath, modifiedContent);
 * await page.waitForTimeout(3000);
 * hmr.dispose();
 *
 * expect(hmr.fullReloads).toHaveLength(0);
 * expect(hmr.updates.length).toBeLessThanOrEqual(2);
 */
export async function captureHmrEvents(page: Page) {
  const events: HmrEvent[] = [];
  const updates: string[] = [];
  const fullReloads: string[] = [];

  const consoleHandler = (msg: ConsoleMessage) => {
    const text = msg.text();
    if (text.includes("[vite] hot updated:")) {
      updates.push(text);
      events.push({ type: "js-update", detail: text, timestamp: Date.now() });
    }
    if (text.includes("[vite] page reload") || text.includes("full reload")) {
      fullReloads.push(text);
      events.push({ type: "full-reload", detail: text, timestamp: Date.now() });
    }
  };

  page.on("console", consoleHandler);

  return {
    events,
    updates,
    fullReloads,
    dispose: () => {
      page.off("console", consoleHandler);
    },
  };
}
