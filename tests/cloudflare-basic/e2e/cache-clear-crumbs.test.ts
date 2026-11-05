import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError, testId } from "./helper";

test.describe.configure({ mode: "serial" });

// A stored HIT lists in `resolvedIds` every segment it sends. The browser
// replaces a run's handle values only when the response delivers values of
// that run or names it in `resolvedIds`; a HIT named no segment, so a handler
// that re-ran and pushed nothing left its breadcrumb on the page. The
// /cache-clear-crumbs layout re-runs on every navigation
// (revalidate(() => true)) and pushes its crumb only on `?cc=1`, so the crumb
// must go on the HIT of the record as it goes on the MISS that wrote it.
//
// The layout's run count, shown on the page, tells the record's stored render
// from a live one: two HITs of one record show the same count, a MISS the next
// one. Runs against the real CFCacheStore in BOTH dev and production (build),
// with the `(production)` tag derived from mode === "build" so dev/prod
// bucketing can never drift (see AGENTS.md e2e bucketing convention).
function describeCacheClearCrumbs(label: string, mode: "dev" | "build") {
  test.describe(`cache-clear-crumbs (${label})`, () => {
    // Dev uses an isolated server so other suites' CF cache state can't race
    // the miss -> HIT sequence this test depends on.
    const f = useFixture({
      root: ".",
      mode,
      ...(mode === "dev" ? { isolatedServer: true } : {}),
    });

    test("a HIT clears the crumb the layout's re-run pushed nothing for", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      const runs = testId(page, "ccc-layout-runs");
      const crumb = testId(page, "breadcrumb-layout");
      const detail = testId(page, "ccc-detail");

      await page.goto(f.url("/cache-clear-crumbs?cc=1"));
      await waitForHydration(page);
      await expect(crumb).toBeVisible();

      // The MISS: the layout re-runs and pushes nothing, and the record it
      // writes holds no crumb for it.
      await testId(page, "ccc-link").click();
      await expect(detail).toHaveText("detail a");
      await expect(crumb).toHaveCount(0);

      // Back on the index page by a link, which pushes the crumb again.
      await testId(page, "ccc-back").click();
      await expect(testId(page, "ccc-index")).toBeVisible();
      await expect(crumb).toBeVisible();

      // The same navigation again, a HIT of that record: its stored layout
      // pushed nothing, so the crumb goes.
      await testId(page, "ccc-link").click();
      await expect(detail).toHaveText("detail a");
      await expect(crumb).toHaveCount(0);
      const hitRuns = await runs.textContent();

      // And once more: the same record, so the same stored render and no
      // handler run. A navigation that missed would show the next count.
      await testId(page, "ccc-back").click();
      await expect(crumb).toBeVisible();
      await testId(page, "ccc-link").click();
      await expect(detail).toHaveText("detail a");
      await expect(runs).toHaveText(hitRuns ?? "");
      await expect(crumb).toHaveCount(0);
    });
  });
}

describeCacheClearCrumbs("dev", "dev");
describeCacheClearCrumbs("production", "build");
