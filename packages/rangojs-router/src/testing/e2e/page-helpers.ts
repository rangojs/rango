// Page helpers for the consumer e2e harness. Type-only Playwright imports keep
// this module loadable in a plain-node process. Helpers needing assertions are
// returned from `createPageHelpers(expect)`; the rest are standalone.

import type { ConsoleMessage, Expect, Locator, Page } from "@playwright/test";

// ============================================================================
//  Standalone helpers (need only a page/locator)
// ============================================================================

/** Get a locator by data-testid attribute. */
export function testId(page: Page, id: string): Locator {
  return page.locator(`[data-testid="${id}"]`);
}

/**
 * Wait for React hydration to complete and verify no hydration errors.
 * Rango sets `data-hydrated` on `<html>` after hydration via useEffect; this
 * is a stable readiness signal that does not rely on React internals.
 */
export async function waitForHydration(page: Page): Promise<void> {
  const hydrationErrors: string[] = [];

  const isHydrationError = (text: string) =>
    text.includes("Hydration failed") ||
    text.includes("hydration mismatch") ||
    text.includes("Text content does not match") ||
    text.includes("did not match") ||
    text.includes("server rendered HTML") ||
    text.includes("Hydration error");

  const consoleHandler = (msg: ConsoleMessage) => {
    const text = msg.text();
    if (isHydrationError(text)) hydrationErrors.push(text);
  };

  // React throws hydration errors as page errors.
  const pageErrorHandler = (error: Error) => {
    if (isHydrationError(error.message)) hydrationErrors.push(error.message);
  };

  page.on("console", consoleHandler);
  page.on("pageerror", pageErrorHandler);

  try {
    await page.waitForLoadState("domcontentloaded");
    await page.waitForFunction(
      () => document.documentElement.hasAttribute("data-hydrated"),
      { timeout: 20000 },
    );
    // Small delay to catch any async hydration errors.
    await page.waitForTimeout(100);
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

/** Wait for navigation to complete (URL change + network idle). */
export async function waitForNavigation(
  page: Page,
  expectedUrl: string | RegExp,
): Promise<void> {
  await page.waitForURL(expectedUrl, { waitUntil: "networkidle" });
}

/** Navigate back and wait for navigation to complete. */
export async function goBack(page: Page): Promise<void> {
  // Wait for the URL to actually CHANGE. A `/.*/ ` pattern matches the current
  // URL immediately, so it would resolve before the history navigation happened.
  const from = page.url();
  await Promise.all([
    page.waitForURL((url) => url.toString() !== from, {
      waitUntil: "networkidle",
    }),
    page.goBack(),
  ]);
}

/** Navigate forward and wait for navigation to complete. */
export async function goForward(page: Page): Promise<void> {
  const from = page.url();
  await Promise.all([
    page.waitForURL((url) => url.toString() !== from, {
      waitUntil: "networkidle",
    }),
    page.goForward(),
  ]);
}

/** Get the current history state. */
export async function getHistoryState(page: Page): Promise<unknown> {
  return page.evaluate(() => window.history.state);
}

/** Wait for an element to appear and be visible. */
export async function waitForElement(
  page: Page,
  selector: string,
  timeout = 10000,
): Promise<void> {
  await page.locator(selector).waitFor({ state: "visible", timeout });
}

/** Check if an element is visible. */
export async function isVisibleInViewport(
  page: Page,
  selector: string,
): Promise<boolean> {
  return page.locator(selector).isVisible();
}

/**
 * Parse a number from text content (finds first number in string).
 *
 * @example
 * parseNumber("Load count: 42") // 42
 * parseNumber(null) // 0
 */
export function parseNumber(text: string | null | undefined): number {
  return parseInt(text?.match(/\d+/)?.[0] || "0", 10);
}

/** Get the numeric value from an element's text content. */
export async function getNumericContent(locator: Locator): Promise<number> {
  const text = await locator.textContent();
  return parseNumber(text);
}

export interface Stopwatch {
  elapsed: () => number;
  checkpoint: () => number;
}

/** Create a stopwatch for timing multiple checkpoints. */
export function createStopwatch(): Stopwatch {
  const startTime = Date.now();
  return {
    elapsed: () => Date.now() - startTime,
    checkpoint: () => Date.now() - startTime,
  };
}

/**
 * Measure elapsed time for an async operation. Returns `{ elapsed, result }`
 * where `elapsed` is in milliseconds.
 */
export async function measureTime<T>(
  fn: () => Promise<T>,
): Promise<{ elapsed: number; result: T }> {
  const startTime = Date.now();
  const result = await fn();
  const elapsed = Date.now() - startTime;
  return { elapsed, result };
}

// ============================================================================
//  Factory-bound helpers (need the injected `expect`)
// ============================================================================

export interface PageHelpers {
  /** Assert that no full page reload occurred between scope entry and exit. */
  expectNoReload: (page: Page) => AsyncDisposable;
  /** Collect page errors and assert none occurred on scope exit. */
  expectNoPageError: (page: Page) => Disposable;
  /** Wait for an element's text to change from its initial value. */
  waitForTextChange: (
    locator: Locator,
    initialText: string,
    timeout?: number,
  ) => Promise<void>;
  /** Wait for a numeric value in an element to change. */
  waitForNumericChange: (
    locator: Locator,
    initialValue: number,
    timeout?: number,
  ) => Promise<void>;
  /** Assert timing is within `expected +/- tolerance`. */
  expectTiming: (elapsed: number, expected: number, tolerance: number) => void;
  /** Assert timing is at least `minimum`. */
  expectMinTiming: (elapsed: number, minimum: number) => void;
  /** Assert timing is less than `maximum`. */
  expectMaxTiming: (elapsed: number, maximum: number) => void;
}

export function createPageHelpers(expect: Expect): PageHelpers {
  function expectNoReload(page: Page): AsyncDisposable {
    const setup = page.evaluate(() => {
      const el = document.createElement("meta");
      el.setAttribute("name", "x-reload-check");
      document.head.append(el);
    });
    return {
      [Symbol.asyncDispose]: async () => {
        await setup;
        // Keep the timeout small so a real reload is reported quickly, but not
        // so small that a busy page produces a spurious failure (which would
        // mask the real test error as a SuppressedError under `await using`).
        await expect(page.locator(`meta[name="x-reload-check"]`)).toBeAttached({
          timeout: 100,
        });
        await page.evaluate(() => {
          document.querySelector(`meta[name="x-reload-check"]`)!.remove();
        });
      },
    };
  }

  function expectNoPageError(page: Page): Disposable {
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

  async function waitForTextChange(
    locator: Locator,
    initialText: string,
    timeout = 10000,
  ): Promise<void> {
    await expect
      .poll(async () => await locator.textContent(), { timeout })
      .not.toBe(initialText);
  }

  async function waitForNumericChange(
    locator: Locator,
    initialValue: number,
    timeout = 10000,
  ): Promise<void> {
    await expect
      .poll(async () => parseNumber(await locator.textContent()), { timeout })
      .not.toBe(initialValue);
  }

  function expectTiming(
    elapsed: number,
    expected: number,
    tolerance: number,
  ): void {
    expect(elapsed).toBeGreaterThan(expected - tolerance);
    expect(elapsed).toBeLessThan(expected + tolerance);
  }

  function expectMinTiming(elapsed: number, minimum: number): void {
    expect(elapsed).toBeGreaterThan(minimum);
  }

  function expectMaxTiming(elapsed: number, maximum: number): void {
    expect(elapsed).toBeLessThan(maximum);
  }

  return {
    expectNoReload,
    expectNoPageError,
    waitForTextChange,
    waitForNumericChange,
    expectTiming,
    expectMinTiming,
    expectMaxTiming,
  };
}
