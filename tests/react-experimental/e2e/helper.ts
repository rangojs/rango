import test, { type Page, type Locator, expect } from "@playwright/test";

/**
 * Wait for React hydration to complete and verify no hydration errors
 */
export async function waitForHydration(page: Page) {
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
      () => document.documentElement.hasAttribute("data-hydrated"),
      { timeout: 20000 },
    );

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
  timeout = 5000,
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

/**
 * Install a MutationObserver that flips a window flag the instant a node with
 * the given test id is attached anywhere in the document. A point-in-time
 * visibility check can race past a skeleton that appears-and-disappears within
 * a frame (on experimental React the view-transition snapshot also masks the
 * timing); the observer cannot miss it.
 */
export async function installSkeletonSentinel(
  page: Page,
  skeletonTestId: string,
) {
  await page.evaluate((id) => {
    const w = window as unknown as { __swrSkeletonSeen?: boolean };
    w.__swrSkeletonSeen = false;
    const selector = `[data-testid="${id}"]`;
    const seen = (node: Node): boolean =>
      node instanceof Element &&
      (node.matches(selector) || !!node.querySelector(selector));
    if (document.querySelector(selector)) w.__swrSkeletonSeen = true;
    new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (seen(node)) w.__swrSkeletonSeen = true;
        }
      }
    }).observe(document.documentElement, { childList: true, subtree: true });
  }, skeletonTestId);
}

export function skeletonSeen(page: Page): Promise<boolean> {
  return page.evaluate(
    () =>
      (window as unknown as { __swrSkeletonSeen?: boolean })
        .__swrSkeletonSeen === true,
  );
}

/**
 * Record calls to document.startViewTransition so a test can assert that a view
 * transition fired and capture its semantic type(s). React experimental's
 * client calls document.startViewTransition({ update, types }) for router-driven
 * transitions; the wrapper MUST forward the argument and return the original's
 * result, or React's transition never resolves. Install AFTER hydration and
 * BEFORE the navigation click.
 */
export async function installVtRecorder(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as {
      __vt?: { count: number; types: string[][] };
    };
    w.__vt = { count: 0, types: [] };
    const doc = document as unknown as {
      startViewTransition?: (arg: unknown) => unknown;
    };
    const orig = doc.startViewTransition?.bind(document);
    if (!orig) return; // no View Transitions API -> count stays 0
    doc.startViewTransition = (arg: unknown) => {
      w.__vt!.count++;
      const t =
        arg && typeof arg === "object"
          ? ((arg as { types?: unknown }).types ?? [])
          : [];
      w.__vt!.types.push(Array.isArray(t) ? [...(t as string[])] : []);
      return orig(arg);
    };
  });
}

export function vtCount(page: Page): Promise<number> {
  return page.evaluate(
    () => (window as unknown as { __vt?: { count: number } }).__vt?.count ?? 0,
  );
}

export function vtTypes(page: Page): Promise<string[][]> {
  return page.evaluate(
    () =>
      (window as unknown as { __vt?: { types: string[][] } }).__vt?.types ?? [],
  );
}
