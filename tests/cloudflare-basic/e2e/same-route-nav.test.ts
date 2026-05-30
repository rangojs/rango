import { expect, test, type Page } from "@playwright/test";
import { useFixture } from "./fixture";
import {
  waitForHydration,
  expectNoPageError,
  expectNoReload,
  testId,
} from "./helper";

/**
 * Same-route stale-while-revalidate navigation on the Cloudflare (workerd)
 * runtime.
 *
 * Navigating between two param values of the SAME route (/features/:slug)
 * reconciles the route subtree and commits inside startTransition, so the
 * previous content stays on screen while the new loader resolves instead of
 * flashing the route's loading() skeleton. This mirrors the node test-app
 * coverage (see packages/rangojs-router/e2e/same-route-nav.test.ts) to confirm
 * identical client behavior over the workerd RSC stream.
 *
 * Route under test: src/urls.tsx -> "/features/:slug" (1s handler delay +
 * loading(<FeatureLoading data-testid="feature-loading" />)). Sibling links
 * (feature-nav-<slug>) drive the same-route navigation.
 *
 * Covered in BOTH dev and production (build) modes.
 */

async function installSkeletonSentinel(page: Page, skeletonTestId: string) {
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

function describeSameRouteNav(label: string, mode: "dev" | "build") {
  test.describe(`same-route navigation (${label})`, () => {
    const f = useFixture({ root: ".", mode });

    test.setTimeout(60000);

    test("same-route nav keeps old content and never flashes the skeleton", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/features/server-components"));
      await waitForHydration(page);
      await expect(testId(page, "feature-title")).toHaveText(
        "Server Components",
      );

      await using __ = await expectNoReload(page);
      await installSkeletonSentinel(page, "feature-loading");

      // Navigate to a different param of the SAME route.
      await testId(page, "feature-nav-server-actions").click();

      // The previous content must remain on screen while the next feature's
      // 1s handler runs: the skeleton must not replace it.
      await expect(testId(page, "feature-title")).toHaveText(
        "Server Components",
      );

      // ...then it swaps to the new content once the handler resolves.
      await expect(testId(page, "feature-title")).toHaveText("Server Actions", {
        timeout: 5000,
      });

      // The skeleton was never attached at any point during the transition.
      expect(
        await page.evaluate(
          () =>
            (window as unknown as { __swrSkeletonSeen?: boolean })
              .__swrSkeletonSeen === true,
        ),
      ).toBe(false);
    });
  });
}

describeSameRouteNav("dev", "dev");
describeSameRouteNav("production", "build");
