import test, { type Page, type Locator, expect } from "@playwright/test";

/**
 * Wait for React hydration to complete and verify no hydration errors
 */
export async function waitForHydration(page: Page, locator: string = "body") {
  const hydrationErrors: string[] = [];

  const consoleHandler = (msg: import("@playwright/test").ConsoleMessage) => {
    const text = msg.text();
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

  const pageErrorHandler = (error: Error) => {
    const text = error.message;
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
    await page.waitForLoadState("domcontentloaded");
    await page.waitForFunction(
      (selector) => {
        const el = document.querySelector(selector);
        return (
          el && Object.keys(el).some((key) => key.startsWith("__reactFiber"))
        );
      },
      locator,
      { timeout: 20000 }
    );
    await page.waitForTimeout(100);

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
 * Navigate back and wait for navigation to complete
 */
export async function goBack(page: Page) {
  await Promise.all([
    page.waitForURL(/.*/, { waitUntil: "networkidle" }),
    page.goBack(),
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
 * Verify that navigation happens without full page reload.
 * Uses network request monitoring to detect document requests which indicate a full reload.
 */
export async function expectNoReload(page: Page) {
  const documentRequests: string[] = [];

  const requestHandler = (request: import("@playwright/test").Request) => {
    // Track document requests (HTML pages) which indicate a full reload
    if (request.resourceType() === "document") {
      documentRequests.push(request.url());
    }
  };

  page.on("request", requestHandler);

  return {
    [Symbol.asyncDispose]: async () => {
      page.off("request", requestHandler);

      if (documentRequests.length > 0) {
        throw new Error(
          `Full page reload detected. Document requests made:\n${documentRequests.join("\n")}`
        );
      }
    },
  };
}
