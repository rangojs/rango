import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import {
  waitForHydration,
  expectNoPageError,
  expectNoReload,
  testId,
  installSkeletonSentinel,
  skeletonSeen,
  installVtRecorder,
  vtCount,
  vtTypes,
} from "./helper";

/**
 * Same-route stale-while-revalidate + morph on EXPERIMENTAL React (ViewTransition
 * present). transition() opt-in: navigating between two param values of the same
 * route (/swr-product/1 -> /swr-product/2) reconciles the route subtree, so the
 * persistent <ViewTransition> boundary animates the param swap (morph) while the
 * previous content is held — no skeleton flash. A route without transition()
 * (/plain-product/:id) remounts and shows its skeleton.
 *
 * This is the experimental-React counterpart to the stable test-app's
 * same-route-nav.test.ts: same routes/testids, plus a ViewTransition assertion.
 *
 * Covered in BOTH dev and production (build) modes.
 */

test.describe.configure({ mode: "serial" });

function describeSameRouteNav(label: string, mode: "dev" | "build") {
  test.describe(`same-route navigation (${label})`, () => {
    const f = useFixture({ root: ".", mode });

    // The build preset + a 600ms loader make production navigations slow.
    test.setTimeout(mode === "build" ? 180000 : 60000);

    test("same-route nav holds content, fires a view transition, no skeleton flash", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/swr-product/1"));
      await waitForHydration(page);
      await expect(testId(page, "swr-product-name")).toHaveText("Product 1");

      await using __ = await expectNoReload(page);
      await installSkeletonSentinel(page, "swr-product-skeleton");
      await installVtRecorder(page);

      await testId(page, "swr-product-link-2").click();

      // Previous content held while the new loader resolves...
      await expect(testId(page, "swr-product-name")).toHaveText("Product 1");
      // ...then swapped.
      await expect(testId(page, "swr-product-name")).toHaveText("Product 2");

      // No skeleton flashed, and a view transition fired with the navigation type.
      expect(await skeletonSeen(page)).toBe(false);
      await expect.poll(() => vtCount(page)).toBeGreaterThanOrEqual(1);
      expect((await vtTypes(page)).flat()).toContain("navigation");
    });

    test("same-route nav reconciles the subtree (local state persists)", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/swr-product/1"));
      await waitForHydration(page);

      await testId(page, "swr-product-counter").click();
      await testId(page, "swr-product-counter").click();
      await expect(testId(page, "swr-product-counter")).toHaveText("count: 2");

      await testId(page, "swr-product-link-3").click();
      await expect(testId(page, "swr-product-name")).toHaveText("Product 3");
      // Reconciled, not remounted: the client counter survives.
      await expect(testId(page, "swr-product-counter")).toHaveText("count: 2");
    });

    test("without transition() the same route remounts and shows the skeleton", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/plain-product/1"));
      await waitForHydration(page);
      await expect(testId(page, "plain-product-name")).toHaveText("Product 1");

      await testId(page, "plain-product-link-2").click();
      await expect(testId(page, "plain-product-skeleton")).toBeVisible({
        timeout: 2000,
      });
      await expect(testId(page, "plain-product-name")).toHaveText("Product 2");
    });
  });
}

describeSameRouteNav("dev", "dev");
describeSameRouteNav("production", "build");
