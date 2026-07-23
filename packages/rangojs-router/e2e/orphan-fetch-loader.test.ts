import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError, testId } from "./helper";

/**
 * Orphan fetchable loader: a loader created with createLoader(fn, true) that is
 * imported ONLY by a client component (OrphanFetchLoaderTest) — never registered
 * on a route via loader(), never imported by any server module. Such a loader
 * is reachable only through the build-time loader manifest, which the
 * _rsc_loader endpoint uses to resolve it at runtime.
 *
 * This app builds with the virtual RSC entry (getVirtualEntryRSC), which imports
 * the loader manifest directly — both before and after the fix. So this suite is
 * a CONTRACT GUARD for the virtual-entry path (it would catch getVirtualEntryRSC
 * dropping the loader-manifest import), NOT the red-before-green pin for the
 * version-injector regression. The regression itself — a custom worker entry
 * missing the loader-manifest import — is pinned by
 * tests/cloudflare-basic/e2e/orphan-fetchable.test.ts. Both dev and production
 * are covered here, per the dev+prod e2e mandate.
 */
test.describe("orphan fetchable loader", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
    isolatedServer: true,
  });

  test.setTimeout(30000);

  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    await page.goto(f.url("/orphan-fetchable"));
    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    await page.close();
  });

  test("resolves a client-only fetchable loader via _rsc_loader", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/orphan-fetchable"));
    await waitForHydration(page);

    await expect(testId(page, "orphan-fetch-test")).toBeVisible();
    await testId(page, "orphan-fetch-btn").click();

    await expect(testId(page, "orphan-fetch-data")).toBeVisible({
      timeout: 5000,
    });
    await expect(testId(page, "orphan-fetch-message")).toContainText(
      "Orphan fetchable loaded!",
    );
    await expect(testId(page, "orphan-fetch-error")).not.toBeVisible();
  });
});

test.describe("orphan fetchable loader (production)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "build",
  });

  test("resolves a client-only fetchable loader via _rsc_loader", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/orphan-fetchable"));
    await waitForHydration(page);

    await testId(page, "orphan-fetch-btn").click();

    await expect(testId(page, "orphan-fetch-data")).toBeVisible({
      timeout: 5000,
    });
    await expect(testId(page, "orphan-fetch-message")).toContainText(
      "Orphan fetchable loaded!",
    );
    await expect(testId(page, "orphan-fetch-error")).not.toBeVisible();
  });
});
