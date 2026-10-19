import { expect, test, type Page } from "@playwright/test";
import { gotoLateHistory, warmUp } from "./late-history-fixture.js";

/**
 * #1205: a DOMContentLoaded a script dispatches leaves the document's Flight
 * stream alone (browser/document-flight-stream.ts). Fixture: late-history.tsx
 * in each app; both apps call this from a dev and a (production) describe.
 */

export interface RedispatchedDomContentLoadedScenarioOptions {
  url: (pathname: string) => string;
}

// Long enough that the boundary still streams after hydration, in dev too.
const SLOW_MS = 4000;

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  page.on("console", (msg) => {
    if (
      msg.type() === "error" &&
      /Connection closed|RootErrorBoundary/.test(msg.text())
    ) {
      errors.push(msg.text());
    }
  });
  return errors;
}

function redispatch(page: Page): Promise<void> {
  return page.evaluate(() => {
    document.dispatchEvent(new Event("DOMContentLoaded"));
  });
}

export function runRedispatchedDomContentLoadedTests(
  options: RedispatchedDomContentLoadedScenarioOptions,
): void {
  test("a DOMContentLoaded dispatched while the page streams leaves the stream open", async ({
    page,
  }) => {
    await warmUp(page, options);
    const errors = collectErrors(page);
    await gotoLateHistory(page, options, `delay=${SLOW_MS}`);
    await expect(page.getByTestId("lh-loading")).toBeVisible();
    await expect(page.getByTestId("lh-slow-value")).toHaveCount(0);

    await redispatch(page);

    await expect(page.getByTestId("lh-slow-value")).toHaveText(
      "slow boundary resolved",
      { timeout: SLOW_MS + 10000 },
    );
    expect(errors).toEqual([]);
  });

  test("a DOMContentLoaded dispatched after the load does not throw", async ({
    page,
  }) => {
    await warmUp(page, options);
    const errors = collectErrors(page);
    // Hydrates while the document streams, so the stream closes from its
    // DOMContentLoaded listener rather than at startup.
    await gotoLateHistory(page, options, "delay=1500");
    await expect(page.getByTestId("lh-loading")).toBeVisible();
    await expect(page.getByTestId("lh-slow-value")).toHaveText(
      "slow boundary resolved",
    );
    await page.waitForFunction(() => document.readyState === "complete");

    await redispatch(page);
    // Page errors reach the test over CDP after the evaluate returns.
    await page.evaluate(
      () => new Promise<void>((resolve) => setTimeout(resolve, 100)),
    );
    expect(errors).toEqual([]);
  });
}
