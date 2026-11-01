import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { expectNoPageError, testId, waitForHydration } from "./helper";

/**
 * A server action from an open intercept re-renders that intercept, not the
 * first one declared for the route (cloudflare-basic counterpart
 * of the router e2e app's cache.test.ts drawer action). Fixture:
 * src/pages/intercept-action-select.tsx. The drawer, declared second, opens
 * from /other while a parallel() default fills the @modal slot of the modal
 * declared first. Its action used to answer with the modal, which opened next
 * to the drawer while the drawer's loader did not re-run.
 */
function interceptActionSelectTests(mode: "dev" | "build") {
  const label = mode === "build" ? "production" : "dev";

  test.describe(`intercept action selection (${label})`, () => {
    const f = useFixture({ root: ".", mode });

    test("an action from the second intercept declared keeps that intercept, its loader re-run, and opens no other", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);
      await page.goto(f.url("/intercept-action-select/other"));
      await waitForHydration(page);

      await testId(page, "ias-other-item").click();
      await expect(testId(page, "ias-drawer")).toHaveText("drawer a");
      await expect(testId(page, "ias-modal-default")).toBeVisible();
      const runs = Number(await testId(page, "ias-drawer-runs").textContent());

      await testId(page, "ias-drawer-action").click();
      await expect
        .poll(async () =>
          Number(await testId(page, "ias-drawer-runs").textContent()),
        )
        .toBeGreaterThan(runs);
      await expect(testId(page, "ias-modal")).toHaveCount(0);
      await expect(testId(page, "ias-modal-default")).toBeVisible();
      await expect(testId(page, "ias-drawer")).toHaveText("drawer a");
      await expect(testId(page, "ias-other")).toBeVisible();
      await expect(page).toHaveURL(/\/intercept-action-select\/item\/a$/);
    });
  });
}

interceptActionSelectTests("dev");
interceptActionSelectTests("build");
