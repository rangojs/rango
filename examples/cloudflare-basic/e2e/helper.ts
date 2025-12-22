import test, { type Page, type Locator, expect } from "@playwright/test";

/**
 * Wait for React hydration to complete
 */
export async function waitForHydration(page: Page, locator: string = "body") {
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
 * Verify that navigation happens without full page reload
 */
export async function expectNoReload(page: Page) {
  await page.evaluate(() => {
    const el = document.createElement("meta");
    el.setAttribute("name", "x-reload-check");
    document.head.append(el);
  });

  return {
    [Symbol.asyncDispose]: async () => {
      await expect(page.locator(`meta[name="x-reload-check"]`)).toBeAttached({
        timeout: 1,
      });
      await page.evaluate(() => {
        document.querySelector(`meta[name="x-reload-check"]`)!.remove();
      });
    },
  };
}
