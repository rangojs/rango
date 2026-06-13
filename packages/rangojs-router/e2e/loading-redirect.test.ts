import { expect, test } from "@playwright/test";
import { useFixture, type Fixture } from "./fixture";
import {
  waitForHydration,
  expectNoPageError,
  testId,
  clickAndWaitFor,
} from "./helper";

// redirect() from a loading() route (M9).
//
// A synchronous handler return of redirect() on a loading() route short-circuits
// to a real HTTP redirect before the streamed loading() boundary takes over.
// Verified for both a hard navigation (initial document load) and a soft
// navigation (client-side Link click), in dev and production.
//
// defineTests takes only the fixture so the dev/production mode stays inline in
// each describe (statically visible coupling, no title drift).
function defineTests(f: Fixture) {
  test("hard navigation to /sync lands on /target", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/loading-redirect/sync"));
    await waitForHydration(page);

    await expect(testId(page, "lr-target")).toBeVisible();
    await expect(page).toHaveURL(/\/loading-redirect\/target$/);
  });

  test("soft navigation (Link click) to /sync lands on /target", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/loading-redirect/"));
    await waitForHydration(page);

    await clickAndWaitFor(testId(page, "lr-link"), testId(page, "lr-target"));
    await expect(page).toHaveURL(/\/loading-redirect\/target$/);
  });
}

// -- Dev mode ----------------------------------------------------------------
test.describe("loading redirect (dev mode)", () => {
  defineTests(useFixture({ root: "./e2e/test-app", mode: "dev" }));
});

// -- Production build --------------------------------------------------------
test.describe("loading redirect (production build)", () => {
  defineTests(useFixture({ root: "./e2e/test-app", mode: "build" }));
});
