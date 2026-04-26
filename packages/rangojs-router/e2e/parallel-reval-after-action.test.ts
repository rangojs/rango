import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import {
  waitForHydration,
  expectNoPageError,
  expectNoReload,
  testId,
} from "./helper";

/**
 * Regression test for PR #482 — parallel slot revalidate() fns must run on
 * sibling-route navigation that follows a server action.
 *
 * Pre-fix: the action's revalidation phase pruned @panel from the client's
 * matched set (the static short-circuit branch in
 * resolveParallelSegmentsWithRevalidation skipped both `matchedIds.push`
 * AND the user's revalidate() fns). The next nav arrived without @panel in
 * `_rsc_segments`, took the same short-circuit, and rendered the slot as
 * `component: null`. The user-observable symptom: clicking a sibling link
 * after an action stops re-rendering the parallel slot.
 *
 * Post-fix: matchedIds.push is unconditional, so the action no longer
 * triggers the prune. As a belt-and-suspenders measure, even when the slot
 * IS missing from clientSegmentIds, evaluateRevalidation now runs with the
 * static decision as the seed — so user revalidate() fns are honored.
 *
 * Assertion: the panel's loader-driven count must increase after each
 * sibling navigation, including the navigation that immediately follows
 * the action.
 */

async function readPanelCount(page: import("@playwright/test").Page) {
  const text = await testId(page, "parallel-reval-count").textContent();
  const n = Number(text);
  expect(Number.isFinite(n)).toBe(true);
  return n;
}

function defineSpec(label: string, mode: "dev" | "build") {
  test.describe(`parallel-reval-after-action (${label})`, () => {
    const f = useFixture({
      root: "./e2e/test-app",
      mode,
    });

    test("panel revalidates on sibling nav following a server action", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/parallel-reval-after-action/page-a"));
      await waitForHydration(page);
      await using __ = await expectNoReload(page);

      // Initial render: panel is mounted with a loader-driven count.
      await expect(testId(page, "reval-after-action-page-a")).toBeVisible();
      await expect(testId(page, "reval-after-action-panel")).toBeVisible();
      const initialCount = await readPanelCount(page);

      // Trigger the server action. With revalidate(({method}) => method ===
      // "POST" ? false : ...), the panel intentionally does NOT refresh on
      // the action itself — but it MUST stay mounted (i.e. matched stays
      // honest about the slot) so the next nav can revalidate it.
      await testId(page, "reval-after-action-trigger").click();
      await expect(
        testId(page, "reval-after-action-trigger-result"),
      ).toBeVisible();
      await expect(testId(page, "reval-after-action-panel")).toBeVisible();

      // Navigate to the sibling route. Pre-fix, this would skip the panel's
      // revalidate() fn entirely and the count would not change (or the
      // slot would render as null).
      await testId(page, "reval-after-action-link-to-b").click();
      await expect(testId(page, "reval-after-action-page-b")).toBeVisible();
      await expect(testId(page, "reval-after-action-panel")).toBeVisible();

      const afterNavCount = await readPanelCount(page);
      expect(afterNavCount).toBeGreaterThan(initialCount);

      // Navigate back. The panel should revalidate again (counts strictly
      // increase since the loader returns Date.now()).
      await testId(page, "reval-after-action-link-to-a").click();
      await expect(testId(page, "reval-after-action-page-a")).toBeVisible();
      await expect(testId(page, "reval-after-action-panel")).toBeVisible();

      const roundTripCount = await readPanelCount(page);
      expect(roundTripCount).toBeGreaterThan(afterNavCount);
    });

    test("panel survives multiple action+nav cycles without prune-and-skip", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/parallel-reval-after-action/page-a"));
      await waitForHydration(page);
      await using __ = await expectNoReload(page);

      await expect(testId(page, "reval-after-action-panel")).toBeVisible();
      let prevCount = await readPanelCount(page);

      // Two action+nav cycles. Pre-fix, the first cycle's action pruned the
      // panel and the subsequent nav would not refresh it; this test pins
      // that the panel stays alive across repeated cycles.
      for (let i = 0; i < 2; i++) {
        await testId(page, "reval-after-action-trigger").click();
        await expect(
          testId(page, "reval-after-action-trigger-result"),
        ).toBeVisible();

        await testId(page, "reval-after-action-link-to-b").click();
        await expect(testId(page, "reval-after-action-page-b")).toBeVisible();
        await expect(testId(page, "reval-after-action-panel")).toBeVisible();
        const afterB = await readPanelCount(page);
        expect(afterB).toBeGreaterThan(prevCount);
        prevCount = afterB;

        await testId(page, "reval-after-action-link-to-a").click();
        await expect(testId(page, "reval-after-action-page-a")).toBeVisible();
        await expect(testId(page, "reval-after-action-panel")).toBeVisible();
        const afterA = await readPanelCount(page);
        expect(afterA).toBeGreaterThan(prevCount);
        prevCount = afterA;
      }
    });
  });
}

defineSpec("dev", "dev");
defineSpec("production", "build");
