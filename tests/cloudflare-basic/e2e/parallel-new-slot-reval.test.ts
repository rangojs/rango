import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError, testId } from "./helper";

/**
 * Workerd twin of packages/rangojs-router/e2e/parallel-new-slot-reval.test.ts:
 * revalidate(() => false) on a route-scoped parallel() slot must not blank the
 * slot on the soft navigation that first introduces it. Pins the fix on the
 * Cloudflare runtime, not just the node dev server.
 *
 * Why it happens: the floored `defaultOverride` seed in the router's
 * segment-resolution/revalidation.ts. Fixture: src/pages/parallel-new-slot-reval.tsx.
 */
function defineSpec(label: string, mode: "dev" | "build") {
  test.describe(`parallel-new-slot-reval (${label})`, () => {
    const f = useFixture({ root: ".", mode });

    test("direct load renders the opted-out slot", async ({ page }) => {
      using _ = expectNoPageError(page);

      // Control: the slot renders on a document request. If this fails the
      // fixture is broken, not the soft-nav path.
      await page.goto(f.url("/parallel-new-slot-reval/with-slot"));
      await waitForHydration(page);

      await expect(testId(page, "cf-new-slot-reval-with-slot")).toBeVisible();
      await expect(testId(page, "cf-new-slot-reval-panel")).toBeVisible();
    });

    test("soft nav from a sibling without the slot still renders it", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      // Land on the sibling that has no @panel — the slot id never enters the
      // client's segment set.
      await page.goto(f.url("/parallel-new-slot-reval/no-slot"));
      await waitForHydration(page);

      await expect(testId(page, "cf-new-slot-reval-no-slot")).toBeVisible();
      await expect(testId(page, "cf-new-slot-reval-panel")).toHaveCount(0);

      // Soft-navigate to the route that owns the slot. Pre-fix the panel
      // stayed blank here.
      await testId(page, "cf-new-slot-reval-link-to-with-slot").click();
      await expect(testId(page, "cf-new-slot-reval-with-slot")).toBeVisible();
      await expect(testId(page, "cf-new-slot-reval-panel")).toHaveText("PANEL");
    });
  });
}

defineSpec("dev", "dev");
defineSpec("production", "build");
