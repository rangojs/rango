import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import {
  waitForHydration,
  expectNoPageError,
  expectNoReload,
  testId,
} from "./helper";

/**
 * End-to-end coverage for ctx.isAction() in a revalidate predicate.
 *
 * The /is-action route registers a loader gated by
 * `revalidate(({ isAction }) => isAction(isActionTargetAction))`. The loader
 * returns a module-level run counter, so the test can observe whether it
 * re-ran:
 *
 *   - firing the TARGET action -> isAction() returns true -> loader re-runs
 *     (counter increases).
 *   - firing the DECOY action  -> isAction() returns false -> hard skip,
 *     overriding the loader's permissive POST default (counter unchanged).
 *
 * This proves the build-injected action id ($id in production RSC, $$id in dev)
 * is resolved consistently on both the imported reference and the live
 * actionId, so matching is correct in both modes.
 */

async function readRuns(
  page: import("@playwright/test").Page,
): Promise<number> {
  const text = await testId(page, "is-action-runs").textContent();
  const n = Number(text);
  expect(Number.isFinite(n)).toBe(true);
  return n;
}

function defineSpec(label: string, mode: "dev" | "build") {
  test.describe(`ctx.isAction (${label})`, () => {
    const f = useFixture({
      root: "./e2e/test-app",
      mode,
    });

    test("target action re-runs the loader; decoy action does not", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/is-action"));
      await waitForHydration(page);
      await using __ = await expectNoReload(page);

      await expect(testId(page, "is-action-page")).toBeVisible();
      const initial = await readRuns(page);

      // Target action matches isAction() -> loader re-runs, counter increases.
      await testId(page, "is-action-target-btn").click();
      await expect.poll(() => readRuns(page)).toBeGreaterThan(initial);
      const afterTarget = await readRuns(page);

      // Decoy action does NOT match -> loader skipped, counter unchanged.
      const decoyResponse = page.waitForResponse(
        (r) =>
          r.url().includes("/is-action") && r.request().method() === "POST",
      );
      await testId(page, "is-action-decoy-btn").click();
      await decoyResponse;
      // The skipped loader never streams a new value; the counter must hold.
      await expect(testId(page, "is-action-runs")).toHaveText(
        String(afterTarget),
      );

      // Target again to confirm matching still fires after a non-match.
      await testId(page, "is-action-target-btn").click();
      await expect.poll(() => readRuns(page)).toBeGreaterThan(afterTarget);
    });
  });
}

defineSpec("dev", "dev");
defineSpec("production", "build");
