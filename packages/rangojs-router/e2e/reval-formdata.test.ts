import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError, testId } from "./helper";

/**
 * shouldRevalidate({ formData }) JS/PE parity (C2).
 *
 * The RevalFormDataLoader's revalidate predicate is a HARD decision read from
 * the action's FormData: `formData?.get("reload") === "yes"`. So:
 *  - "Reload No"  -> reload=no  -> predicate false -> loader does NOT re-run.
 *  - "Reload Yes" -> reload=yes -> predicate true  -> loader re-runs (counter++).
 *
 * Under the pre-fix bug the JS action's formData was undefined (or carried
 * Flight-encoded keys like `_1_reload`), so `reload=yes` would NOT re-run and
 * the counter would stay flat. This test pins that the FormData reaches the
 * predicate with the clean key, dev and production.
 *
 * This is a JS-path concern only: shouldRevalidate gates the partial-revalidation
 * render that the JS action transport drives. The no-JS (PE) transport re-renders
 * the whole page via a full match (ctx.router.match), which runs every loader
 * unconditionally and never consults shouldRevalidate — so there is no PE
 * counterpart to gate. (Matches the is-action fixture, which is JS-only for the
 * same reason.)
 */

async function readRuns(
  page: import("@playwright/test").Page,
): Promise<number> {
  const text = await testId(page, "reval-formdata-runs").textContent();
  const n = Number(text);
  expect(Number.isFinite(n)).toBe(true);
  return n;
}

function defineSpec(label: string, mode: "dev" | "build") {
  test.describe(`shouldRevalidate formData — JS (${label})`, () => {
    const f = useFixture({ root: "./e2e/test-app", mode });

    test("reload=yes re-runs the loader; reload=no does not", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/reval-formdata"));
      await waitForHydration(page);

      await expect(testId(page, "reval-formdata-page")).toBeVisible();
      const initial = await readRuns(page);

      // reload=no -> predicate false (formData reached the predicate with the
      // clean key) -> loader does NOT re-run. Counter must hold.
      await testId(page, "reval-formdata-no-btn").click();
      // Give the action round-trip time to settle, then assert no change.
      await page.waitForTimeout(300);
      await expect(testId(page, "reval-formdata-runs")).toHaveText(
        String(initial),
      );

      // reload=yes -> predicate true -> loader re-runs. Counter must increment.
      await testId(page, "reval-formdata-yes-btn").click();
      await expect.poll(() => readRuns(page)).toBeGreaterThan(initial);
    });
  });
}

defineSpec("dev", "dev");
defineSpec("production", "build");
