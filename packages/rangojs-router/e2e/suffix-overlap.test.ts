import { expect, test } from "@playwright/test";
import { useFixture, type Fixture } from "./fixture";
import { waitForHydration, expectNoPageError, testId } from "./helper";

// Suffix-param longest-wins (#568).
//
// Overlapping suffixes resolve by specificity (longest literal suffix), never by
// route declaration order. The shorter `.data` route is declared before the
// longer `.v2.data` route, so without the build-time sort (sortSuffixParams)
// `/suffix-overlap/app.v2.data` would wrongly match `:file.data` (file
// "app.v2"). Verified in dev and production.
//
// defineTests takes only the fixture so the dev/production mode stays inline in
// each describe (statically visible coupling, no title drift).
function defineTests(f: Fixture) {
  test("longest suffix wins: /app.v2.data matches :file.v2.data", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/suffix-overlap/app.v2.data"));
    await waitForHydration(page);

    await expect(testId(page, "suffix-v2data")).toBeVisible();
    await expect(testId(page, "suffix-v2data-file")).toHaveText("app");
  });

  test("shorter suffix still matches: /app.data matches :file.data", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/suffix-overlap/app.data"));
    await waitForHydration(page);

    await expect(testId(page, "suffix-data")).toBeVisible();
    await expect(testId(page, "suffix-data-file")).toHaveText("app");
  });
}

// -- Dev mode ----------------------------------------------------------------
test.describe("suffix overlap longest-wins (dev mode)", () => {
  defineTests(useFixture({ root: "./e2e/test-app", mode: "dev" }));
});

// -- Production build --------------------------------------------------------
test.describe("suffix overlap longest-wins (production build)", () => {
  defineTests(useFixture({ root: "./e2e/test-app", mode: "build" }));
});
