import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import {
  waitForHydration,
  expectNoPageError,
  expectNoReload,
  testId,
} from "./helper";

/**
 * Same-route stale-while-revalidate navigation, opt-in via the transition()
 * DSL.
 *
 * A route that declares transition() drops the param from its key, so
 * navigating between two param values of the SAME route (e.g. /swr-product/1 ->
 * /swr-product/2) reconciles the route subtree instead of remounting it, and
 * the startTransition wrap that shouldStartViewTransition already applies to
 * transition routes keeps the previous content on screen while the new loader
 * resolves — no skeleton flash. This works on stable React (no ViewTransition).
 *
 * A route WITHOUT transition() remounts on param change and shows its skeleton
 * (the default; covered by the plain-product case below). Cross-route
 * navigations always remount and show the destination skeleton.
 *
 * Routes under test: e2e/test-app/src/urls.tsx -> "/swr-product/:id" (with
 * transition()) and "/plain-product/:id" (without). Both: 600ms loader, a
 * loading() skeleton, and a client useState counter.
 *
 * Covered in BOTH dev and production (build) modes.
 */

/**
 * Install a MutationObserver that flips a window flag the instant a node with
 * the given test id is attached anywhere in the document. A point-in-time
 * visibility check can race past a skeleton that appears-and-disappears within
 * a frame (the exact regression); the observer cannot miss it.
 */
async function installSkeletonSentinel(
  page: import("@playwright/test").Page,
  skeletonTestId: string,
) {
  await page.evaluate((id) => {
    const w = window as unknown as { __swrSkeletonSeen?: boolean };
    w.__swrSkeletonSeen = false;
    const selector = `[data-testid="${id}"]`;
    const seen = (node: Node): boolean => {
      if (!(node instanceof Element)) return false;
      return node.matches(selector) || !!node.querySelector(selector);
    };
    // Catch a skeleton already present at install time, too.
    if (document.querySelector(selector)) w.__swrSkeletonSeen = true;
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (seen(node)) w.__swrSkeletonSeen = true;
        }
      }
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  }, skeletonTestId);
}

async function skeletonSeen(
  page: import("@playwright/test").Page,
): Promise<boolean> {
  return page.evaluate(
    () =>
      (window as unknown as { __swrSkeletonSeen?: boolean })
        .__swrSkeletonSeen === true,
  );
}

function describeSameRouteNav(label: string, mode: "dev" | "build") {
  test.describe(`same-route navigation (${label})`, () => {
    const f = useFixture({
      root: "./e2e/test-app",
      mode,
      isolatedServer: mode === "dev" ? true : undefined,
    });

    test.setTimeout(30000);

    test("same-route nav keeps old content and never flashes the skeleton", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/swr-product/1"));
      await waitForHydration(page);
      await expect(testId(page, "swr-product-name")).toHaveText("Product 1");

      await using __ = await expectNoReload(page);
      await installSkeletonSentinel(page, "swr-product-skeleton");

      // Navigate to a different param of the SAME route.
      await testId(page, "swr-product-link-2").click();

      // The previous content (Product 1) must remain visible while the new
      // loader is pending: the skeleton must not replace it.
      await expect(testId(page, "swr-product-name")).toHaveText("Product 1");

      // ...then it swaps to the new content once the loader resolves.
      await expect(testId(page, "swr-product-name")).toHaveText("Product 2");

      // The skeleton was never attached at any point during the transition.
      expect(await skeletonSeen(page)).toBe(false);
    });

    test("same-route nav reconciles the subtree (local state persists)", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/swr-product/1"));
      await waitForHydration(page);
      await expect(testId(page, "swr-product-name")).toHaveText("Product 1");

      // Bump the client useState counter.
      await testId(page, "swr-product-counter").click();
      await testId(page, "swr-product-counter").click();
      await expect(testId(page, "swr-product-counter")).toHaveText("count: 2");

      // Same-route navigation reconciles (does not remount), so the counter
      // state survives and the route content still refreshes to the new param.
      await testId(page, "swr-product-link-3").click();
      await expect(testId(page, "swr-product-name")).toHaveText("Product 3");
      await expect(testId(page, "swr-product-counter")).toHaveText("count: 2");
    });

    test("cross-route nav still shows the destination skeleton", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/swr-product/1"));
      await waitForHydration(page);
      await expect(testId(page, "swr-product-name")).toHaveText("Product 1");

      // Navigating to a DIFFERENT route (slow-streaming, 1s loader + skeleton)
      // remounts and must show that route's loading skeleton.
      await testId(page, "swr-product-cross-route-link").click();
      await expect(testId(page, "slow-streaming-loading")).toBeVisible({
        timeout: 2000,
      });
    });

    test("without transition() the same route still remounts and shows the skeleton", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/plain-product/1"));
      await waitForHydration(page);
      await expect(testId(page, "plain-product-name")).toHaveText("Product 1");

      // No transition() opt-in: navigating between params remounts the route,
      // so its loading skeleton appears (the default behavior, unchanged).
      await testId(page, "plain-product-link-2").click();
      await expect(testId(page, "plain-product-skeleton")).toBeVisible({
        timeout: 2000,
      });
      await expect(testId(page, "plain-product-name")).toHaveText("Product 2");
    });

    // Block-form transition() (a shared wrapper over two distinct routes):
    // same-route nav inside the block still holds.
    test("block-form same-route nav holds and never flashes the skeleton", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/tx-group-a/1"));
      await waitForHydration(page);
      await expect(testId(page, "tx-group-a-name")).toHaveText("Product 1");

      await using __ = await expectNoReload(page);
      await installSkeletonSentinel(page, "tx-group-a-skeleton");

      await testId(page, "tx-a-link-2").click();
      await expect(testId(page, "tx-group-a-name")).toHaveText("Product 1");
      await expect(testId(page, "tx-group-a-name")).toHaveText("Product 2");
      expect(await skeletonSeen(page)).toBe(false);
    });

    // Cross-route inside the same block remounts (shows the destination
    // skeleton) while the shared wrapper chain persists — transition grouping
    // affects only the animation, never hold/skeleton across different routes.
    test("cross-route inside the same block remounts; shared wrapper persists", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/tx-group-a/1"));
      await waitForHydration(page);
      await expect(testId(page, "tx-block-shell")).toBeVisible();
      const shell = await testId(page, "tx-block-shell").elementHandle();

      await using __ = await expectNoReload(page);
      await testId(page, "tx-cross-b-link").click();

      await expect(testId(page, "tx-group-b-skeleton")).toBeVisible({
        timeout: 2000,
      });
      await expect(testId(page, "tx-group-b-name")).toHaveText("Product 1");
      // The shared TxBlockShell instance was reconciled, not remounted.
      expect(await shell!.evaluate((n) => (n as Element).isConnected)).toBe(
        true,
      );
    });

    // Two routes each in their OWN transition() block: navigating between them
    // is cross-route, so the destination skeleton must still appear.
    test("own-transition cross-route nav shows the destination skeleton", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/own-tx-one/1"));
      await waitForHydration(page);
      await expect(testId(page, "own-tx-one-name")).toHaveText("Product 1");

      await using __ = await expectNoReload(page);
      await testId(page, "own-tx-cross-link").click();

      await expect(testId(page, "own-tx-two-skeleton")).toBeVisible({
        timeout: 2000,
      });
      await expect(testId(page, "own-tx-two-name")).toHaveText("Product 1");
    });
  });
}

describeSameRouteNav("dev", "dev");
describeSameRouteNav("production", "build");
