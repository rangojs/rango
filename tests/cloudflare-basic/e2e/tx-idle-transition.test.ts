import { expect, test, type Page } from "@playwright/test";
import { useFixture } from "./fixture";
import { expectNoPageError, testId, waitForHydration } from "./helper";

/**
 * #1078: under transition() + loading(), React's Suspense retry after the
 * first of two loaders commits with the fallback still in place and runs a
 * view transition that changes nothing; the real reveal waits for it. The two
 * escape hatches documented in skills/view-transitions start no view
 * transition at all on the same click.
 *
 * Fixture: src/pages/tx-when.tsx (/tx-idle/*). Counts
 * document.startViewTransition calls, not milliseconds: the count is
 * deterministic, the timing is not. Mirrors
 * packages/rangojs-router/e2e/transition-idle-view-transition.test.ts so the
 * pin holds in BOTH the router e2e app and cloudflare-basic (dev +
 * production).
 */

async function countViewTransitions(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __vtCount?: number };
    w.__vtCount = 0;
    const original = document.startViewTransition?.bind(document);
    if (!original) return;
    document.startViewTransition = ((arg: unknown) => {
      w.__vtCount = (w.__vtCount ?? 0) + 1;
      return original(arg as never);
    }) as typeof document.startViewTransition;
  });
}

async function viewTransitions(page: Page): Promise<number> {
  return page.evaluate(
    () => (window as unknown as { __vtCount?: number }).__vtCount ?? 0,
  );
}

function idleViewTransitionTests(mode: "dev" | "build") {
  const label = mode === "build" ? "production" : mode;

  test.describe(`transition idle view transition (${label})`, () => {
    const f = useFixture({ root: ".", mode });
    test.setTimeout(60000);

    test("transition({ when: () => false }) and transition({ viewTransition: false }) start no view transition on a cold click to loading() with two loaders", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);
      await countViewTransitions(page);

      // A fresh document per variant: cold click, nothing prefetched.
      const clickCount = async (variant: "default" | "when" | "off") => {
        await page.goto(f.url("/tx-idle"));
        await waitForHydration(page);
        await expect(testId(page, "tx-idle-index").last()).toBeVisible();
        await testId(page, `tx-idle-to-${variant}`).click();
        await expect(testId(page, "tx-idle-slow").last()).toHaveText("v:400", {
          timeout: 8000,
        });
        // A late transition would start after the content lands.
        await page.waitForTimeout(800);
        return viewTransitions(page);
      };

      // Control: the default transition() runs at least the navigation's and
      // the reveal's transition, so a zero below is the hatch, not a page
      // that never animates.
      expect(
        await clickCount("default"),
        "transition() starts view transitions here",
      ).toBeGreaterThanOrEqual(2);
      expect(
        await clickCount("when"),
        "transition({ when: () => false }) gates every router <ViewTransition> off",
      ).toBe(0);
      expect(
        await clickCount("off"),
        "transition({ viewTransition: false }) places no router <ViewTransition>",
      ).toBe(0);
    });
  });
}

idleViewTransitionTests("dev");
idleViewTransitionTests("build");
