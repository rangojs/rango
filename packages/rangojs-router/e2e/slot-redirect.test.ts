import { expect, test } from "@playwright/test";
import { useFixture, type Fixture } from "./fixture";
import {
  waitForHydration,
  expectNoPageError,
  testId,
  clickAndWaitFor,
} from "./helper";

// A parallel slot handler's redirect.
//
// A slot handler's returned redirect() short-circuits the request like a route
// or layout handler's: a document request answers 302 and lands on the target,
// a client navigation answers a Flight redirect and lands there too, and an
// on-demand refresh reports the redirect while the page stored before keeps
// serving. Before the fix the Response became the slot's component: the
// document answered 200 with an error row and the refresh failed with a Flight
// serialization error.
//
// defineTests takes only the fixture so the dev/production mode stays inline in
// each describe (statically visible coupling, no title drift).
function defineTests(f: Fixture) {
  test("hard navigation to a slot's redirect lands on the target", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/slot-redirect/redirect"));
    await waitForHydration(page);

    await expect(page).toHaveURL(/\/slot-redirect\/target$/);
    await expect(testId(page, "sr-target")).toBeVisible();
  });

  test("soft navigation (Link click) to a slot's redirect lands on the target", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/slot-redirect/"));
    await waitForHydration(page);
    await expect(testId(page, "sr-index")).toBeVisible();

    await clickAndWaitFor(
      testId(page, "sr-link-redirect"),
      testId(page, "sr-target"),
    );
    await expect(page).toHaveURL(/\/slot-redirect\/target$/);
  });

  test("the slot renders normally on a page that does not redirect", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/slot-redirect/plain"));
    await waitForHydration(page);

    await expect(testId(page, "sr-aside")).toHaveText("aside body");
    await expect(testId(page, "sr-plain")).toBeVisible();
  });

  test("on-demand refresh: the redirect is reported and the stored page keeps serving", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // Store the page.
    const first = await page.request.get(f.url("/slot-redirect/od-trigger"));
    expect(await first.json()).toMatchObject({ ok: true, status: "rendered" });

    await page.goto(f.url("/slot-redirect/od"));
    await waitForHydration(page);
    const stored = await testId(page, "sr-od-stamp").textContent();

    // The slot starts redirecting: a refresh meets the redirect.
    await page.request.get(f.url("/slot-redirect/od-trigger?slot=1"));
    const refreshed = await page.request.get(
      f.url("/slot-redirect/od-trigger"),
    );
    expect(await refreshed.json()).toMatchObject({
      ok: false,
      status: "render-failed",
      // The redirect itself, not a Flight serialization error.
      error: { response: 302, location: "/slot-redirect/target" },
    });

    // Nothing was stored in its place: the page stored before keeps serving.
    await page.goto(f.url("/slot-redirect/od"));
    await waitForHydration(page);
    await expect(testId(page, "sr-od-stamp")).toHaveText(stored);

    // Back to a slot that renders, for the rest of the suite.
    await page.request.get(f.url("/slot-redirect/od-trigger?slot=0"));
  });
}

// -- Dev mode ----------------------------------------------------------------
test.describe("slot redirect (dev mode)", () => {
  defineTests(useFixture({ root: "./e2e/test-app", mode: "dev" }));
});

// -- Production build --------------------------------------------------------
test.describe("slot redirect (production)", () => {
  defineTests(useFixture({ root: "./e2e/test-app", mode: "build" }));
});
