import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import {
  waitForHydration,
  expectNoPageError,
  expectNoReload,
  testId,
} from "./helper";

/**
 * useLoader().isLoading during a HELD navigation on the Cloudflare (workerd)
 * runtime. Mirrors packages/rangojs-router/e2e/loader-nav-stale.test.ts.
 *
 * /features/:slug opts into transition(), so feature -> feature keeps the
 * current content on screen while FeatureLoader (800ms) streams for the next
 * slug. The held read must report `isLoading: true` for the data it is still
 * showing, and flip to false only in the commit that swaps the data (the
 * handler's own 1s delay holds the commit past the loader settling, so the
 * flag must outlive the stream, not just the loader).
 *
 * Probe: src/components/FeatureStatus.tsx renders "<stale|fresh>:<slug>" and
 * logs every distinct value to window.__featureStatusLog.
 *
 * Covered in BOTH dev and production (build) modes.
 */
function describeLoaderNavStale(label: string, mode: "dev" | "build") {
  test.describe(`useLoader isLoading on held navigation (${label})`, () => {
    const f = useFixture({ root: ".", mode });

    test.setTimeout(60000);

    test("held content reports isLoading:true while the next loader streams, then fresh with the new data", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/features/server-components"));
      await waitForHydration(page);
      await expect(testId(page, "feature-status")).toHaveText(
        "fresh:server-components",
      );

      await using __ = await expectNoReload(page);

      await testId(page, "feature-nav-server-actions").click();

      await expect(testId(page, "feature-status")).toHaveText(
        "stale:server-components",
      );
      await expect(testId(page, "feature-status")).toHaveText(
        "fresh:server-actions",
        { timeout: 5000 },
      );

      const log = await page.evaluate(() => window.__featureStatusLog);
      expect(log).toEqual([
        "fresh:server-components",
        "stale:server-components",
        "fresh:server-actions",
      ]);
    });

    test("a layout loader the navigation does not re-run never reports isLoading:true", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      // FeaturesShell registers FeatureShellLoader; the route registers
      // FeatureLoader. A feature -> feature nav re-runs only the route's
      // loader: the shell reader keeps its data AND stays fresh.
      await page.goto(f.url("/features/server-components"));
      await waitForHydration(page);
      await expect(testId(page, "feature-shell-status")).toHaveText(
        "fresh:shell",
      );
      await expect(testId(page, "feature-status")).toHaveText(
        "fresh:server-components",
      );
      const shellLoadedAt = await testId(
        page,
        "feature-shell-status",
      ).getAttribute("data-loaded-at");

      await using __ = await expectNoReload(page);
      await testId(page, "feature-nav-server-actions").click();

      await expect(testId(page, "feature-status")).toHaveText(
        "stale:server-components",
      );
      await expect(testId(page, "feature-shell-status")).toHaveText(
        "fresh:shell",
      );
      await expect(testId(page, "feature-status")).toHaveText(
        "fresh:server-actions",
        { timeout: 5000 },
      );

      expect(await page.evaluate(() => window.__featureShellStatusLog)).toEqual(
        ["fresh:shell"],
      );
      await expect(testId(page, "feature-shell-status")).toHaveAttribute(
        "data-loaded-at",
        shellLoadedAt!,
      );
    });
  });
}

describeLoaderNavStale("dev", "dev");
describeLoaderNavStale("production", "build");
