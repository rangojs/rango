import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import {
  waitForHydration,
  expectNoPageError,
  expectNoReload,
  testId,
} from "./helper";

/**
 * revalidate(() => false) on a parallel() slot must not blank the slot on the
 * soft navigation that first introduces it. Node dev-server + preview coverage;
 * the workerd twin is tests/cloudflare-basic/e2e/parallel-new-slot-reval.test.ts
 * and the originally-reported app case is
 * tests/vite-rsc-demo/e2e/shop-sidebar-new-slot.test.ts.
 *
 * Why it happens: src/router/segment-resolution/revalidation.ts (the floored
 * `defaultOverride` seed). Fixture: src/urls/parallel-new-slot-reval.tsx.
 */
function defineSpec(label: string, mode: "dev" | "build") {
  test.describe(`parallel-new-slot-reval (${label})`, () => {
    const f = useFixture({
      root: "./e2e/test-app",
      mode,
    });

    test("direct load renders the opted-out slot", async ({ page }) => {
      using _ = expectNoPageError(page);

      // Control: the slot renders on a document request. If this fails, the
      // fixture is broken rather than the soft-nav path.
      await page.goto(f.url("/parallel-new-slot-reval/with-slot"));
      await waitForHydration(page);

      await expect(testId(page, "new-slot-reval-with-slot")).toBeVisible();
      await expect(testId(page, "new-slot-reval-panel")).toBeVisible();
    });

    test("soft nav from a sibling without the slot still renders it", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      // Land on the sibling that has no @panel — the slot id never enters the
      // client's segment set.
      await page.goto(f.url("/parallel-new-slot-reval/no-slot"));
      await waitForHydration(page);
      await using __ = await expectNoReload(page);

      await expect(testId(page, "new-slot-reval-no-slot")).toBeVisible();
      await expect(testId(page, "new-slot-reval-panel")).toHaveCount(0);

      // Soft-navigate to the route that owns the slot. Pre-fix the panel
      // stayed blank here.
      await testId(page, "new-slot-reval-link-to-with-slot").click();
      await expect(testId(page, "new-slot-reval-with-slot")).toBeVisible();
      await expect(testId(page, "new-slot-reval-panel")).toHaveText("PANEL");
    });

    test("slot renders again on re-entry, once the client already knows it", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/parallel-new-slot-reval/no-slot"));
      await waitForHydration(page);
      await using __ = await expectNoReload(page);

      // First entry takes the floored path (slot unknown to the client).
      await testId(page, "new-slot-reval-link-to-with-slot").click();
      await expect(testId(page, "new-slot-reval-panel")).toHaveText("PANEL");

      await testId(page, "new-slot-reval-link-to-no-slot").click();
      await expect(testId(page, "new-slot-reval-no-slot")).toBeVisible();

      // Re-entry takes the other branch — no floor, the user's `false` is
      // honored and the client keeps its copy. Panel must still be on screen.
      await testId(page, "new-slot-reval-link-to-with-slot").click();
      await expect(testId(page, "new-slot-reval-panel")).toHaveText("PANEL");
    });
  });
}

defineSpec("dev", "dev");
defineSpec("production", "build");
