import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import {
  waitForHydration,
  expectNoPageError,
  expectNoReload,
  testId,
} from "./helper";

/**
 * useLoader().isLoading during a HELD navigation.
 *
 * /swr-product/:id opts into transition(), so /swr-product/1 -> /swr-product/2
 * keeps Product 1 on screen while SwrProductLoader (600ms) streams for
 * Product 2. While that stream is pending, the held read must report
 * `isLoading: true` — the pre-step that lets a consumer mark the still-visible
 * data as stale — and flip back to false when the new data commits.
 *
 * Probe: e2e/test-app/src/components/SwrProductStatus.tsx renders
 * "<stale|fresh>:<name>" and logs every distinct value to
 * window.__swrStatusLog, so the exact sequence is asserted.
 *
 * Covered in BOTH dev and production (build) modes.
 */
function describeLoaderNavStale(label: string, mode: "dev" | "build") {
  test.describe(`useLoader isLoading on held navigation (${label})`, () => {
    const f = useFixture({
      root: "./e2e/test-app",
      mode,
      isolatedServer: mode === "dev" ? true : undefined,
    });

    test.setTimeout(30000);

    test("held content reports isLoading:true while the next loader streams, then fresh with the new data", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/swr-product/1"));
      await waitForHydration(page);
      await expect(testId(page, "swr-product-status")).toHaveText(
        "fresh:Product 1",
      );

      await using __ = await expectNoReload(page);

      await testId(page, "swr-product-link-2").click();

      // Old data still visible, flagged stale while the new loader streams.
      await expect(testId(page, "swr-product-status")).toHaveText(
        "stale:Product 1",
      );
      // New data lands and the flag clears.
      await expect(testId(page, "swr-product-status")).toHaveText(
        "fresh:Product 2",
      );

      const log = await page.evaluate(() => window.__swrStatusLog);
      expect(log).toEqual([
        "fresh:Product 1",
        "stale:Product 1",
        "fresh:Product 2",
      ]);
    });

    test("a layout loader the navigation does not re-run never reports isLoading:true", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      // TxShellLayout registers TxShellLoader; /tx-group-a/:id (inside the
      // block's transition()) registers SwrProductLoader. A same-route nav
      // re-runs only the route's loader: the shell reader keeps its data AND
      // stays fresh, while the route reader flags its held data stale.
      await page.goto(f.url("/tx-group-a/1"));
      await waitForHydration(page);
      await expect(testId(page, "tx-shell-status")).toHaveText("fresh:shell");
      await expect(testId(page, "swr-product-status")).toHaveText(
        "fresh:Product 1",
      );
      const shellLoadedAt = await testId(page, "tx-shell-status").getAttribute(
        "data-loaded-at",
      );

      await using __ = await expectNoReload(page);
      await testId(page, "tx-a-link-2").click();

      await expect(testId(page, "swr-product-status")).toHaveText(
        "stale:Product 1",
      );
      await expect(testId(page, "tx-shell-status")).toHaveText("fresh:shell");
      await expect(testId(page, "swr-product-status")).toHaveText(
        "fresh:Product 2",
      );

      expect(await page.evaluate(() => window.__txShellStatusLog)).toEqual([
        "fresh:shell",
      ]);
      expect(await page.evaluate(() => window.__swrStatusLog)).toEqual([
        "fresh:Product 1",
        "stale:Product 1",
        "fresh:Product 2",
      ]);
      // The shell loader did not re-run: same loadedAt as before the nav.
      await expect(testId(page, "tx-shell-status")).toHaveAttribute(
        "data-loaded-at",
        shellLoadedAt!,
      );
    });
  });
}

describeLoaderNavStale("dev", "dev");
describeLoaderNavStale("production", "build");
