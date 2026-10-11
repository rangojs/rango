import { expect, test, type Page } from "@playwright/test";
import {
  countViewTransitions,
  viewTransitions,
} from "./view-transition-probe.js";

/**
 * #1078: under transition() + loading(), React's Suspense retry after the
 * first of two loaders commits with the fallback still in place and runs a
 * view transition that changes nothing; the real reveal waits for it. The two
 * escape hatches documented in skills/view-transitions start no view
 * transition at all on the same click. Fixture: /tx-idle/* in each app. Counts
 * document.startViewTransition calls, not milliseconds: the count is
 * deterministic, the timing is not.
 */

export interface TxIdleViewTransitionScenarioOptions {
  url: (pathname: string) => string;
  waitForHydration: (page: Page) => Promise<void>;
}

const testId = (page: Page, id: string) =>
  page.locator(`[data-testid="${id}"]`);

// Two animation frames and a short tail: a late transition would start in
// the commit that lands the content, not after it.
function settle(page: Page): Promise<void> {
  return page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() =>
          requestAnimationFrame(() => setTimeout(resolve, 100)),
        ),
      ),
  );
}

export function runTxIdleViewTransitionTests(
  options: TxIdleViewTransitionScenarioOptions,
): void {
  test("transition({ when: () => false }) and transition({ viewTransition: false }) start no view transition on a cold click to loading() with two loaders", async ({
    page,
  }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await countViewTransitions(page);

    // A fresh document per variant: cold click, nothing prefetched.
    const clickTo = async (variant: "default" | "when" | "off") => {
      await page.goto(options.url("/tx-idle"));
      await options.waitForHydration(page);
      await expect(testId(page, "tx-idle-index").last()).toBeVisible();
      await testId(page, `tx-idle-to-${variant}`).click();
      await expect(testId(page, "tx-idle-slow").last()).toHaveText("v:400", {
        timeout: 8000,
      });
    };

    // Control: the default transition() runs at least the navigation's and
    // the reveal's transition, so a zero below is the hatch, not a page that
    // never animates.
    await clickTo("default");
    await expect
      .poll(() => viewTransitions(page), {
        message: "transition() starts view transitions here",
      })
      .toBeGreaterThanOrEqual(2);

    await clickTo("when");
    await settle(page);
    expect(
      await viewTransitions(page),
      "transition({ when: () => false }) gates every router <ViewTransition> off",
    ).toBe(0);

    await clickTo("off");
    await settle(page);
    expect(
      await viewTransitions(page),
      "transition({ viewTransition: false }) places no router <ViewTransition>",
    ).toBe(0);

    expect(pageErrors).toEqual([]);
  });
}
