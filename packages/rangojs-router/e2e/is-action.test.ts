import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import {
  waitForHydration,
  expectNoPageError,
  expectNoReload,
  testId,
} from "./helper";

// Two loaders: one gated by isAction(target) (re-runs only on the target action),
// one by bare isAction() (re-runs on ANY action, incl. the decoy). Dev + prod.
async function readRuns(
  page: import("@playwright/test").Page,
): Promise<number> {
  const text = await testId(page, "is-action-runs").textContent();
  const n = Number(text);
  expect(Number.isFinite(n)).toBe(true);
  return n;
}

// The bare-isAction()-gated loader's run counter. It re-runs on ANY action.
async function readAnyRuns(
  page: import("@playwright/test").Page,
): Promise<number> {
  const text = await testId(page, "is-action-any-runs").textContent();
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
      const initialAny = await readAnyRuns(page);

      // Target action matches isAction(target) -> target loader re-runs. It is
      // also an action, so the bare-isAction() loader re-runs too.
      await testId(page, "is-action-target-btn").click();
      await expect.poll(() => readRuns(page)).toBeGreaterThan(initial);
      await expect.poll(() => readAnyRuns(page)).toBeGreaterThan(initialAny);
      const afterTarget = await readRuns(page);
      const afterTargetAny = await readAnyRuns(page);

      // Decoy action does NOT match the target -> target loader skipped. But it
      // IS an action, so bare isAction() is true and the "any" loader re-runs.
      await testId(page, "is-action-decoy-btn").click();
      // The bare-gated loader re-runs on the decoy (proves bare isAction() ==
      // "any action"); the target-gated loader holds.
      await expect
        .poll(() => readAnyRuns(page))
        .toBeGreaterThan(afterTargetAny);
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
