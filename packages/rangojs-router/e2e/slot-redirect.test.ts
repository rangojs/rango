import { expect, test } from "@playwright/test";
import { useFixture, type Fixture } from "./fixture";
import {
  waitForHydration,
  expectNoPageError,
  testId,
  clickAndWaitFor,
} from "./helper";

// A parallel slot handler's redirect().
//
// A slot handler's result passes through handleHandlerResult, as a route's or a
// layout's does: a returned redirect() short-circuits to a real HTTP redirect
// on a document load and to the soft redirect a client navigation follows, and
// a synchronous return under the slot's own loading() does the same. Before
// that funnel the Response was rendered as the slot's component: 200 with no
// Location on the document, a rendered Response in the partial payload.
//
// defineTests takes only the fixture so the dev/production mode stays inline in
// each describe (statically visible coupling, no title drift).
function defineTests(f: Fixture) {
  test("hard navigation to a slot that returns redirect() lands on /target", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/slot-redirect/plain"));
    await waitForHydration(page);

    await expect(testId(page, "sr-target")).toBeVisible();
    await expect(page).toHaveURL(/\/slot-redirect\/target$/);
  });

  test("hard navigation to a slot that returns redirect() under loading() lands on /target", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/slot-redirect/streamed"));
    await waitForHydration(page);

    await expect(testId(page, "sr-target")).toBeVisible();
    await expect(page).toHaveURL(/\/slot-redirect\/target$/);
  });

  test("soft navigation (Link click) to a slot that returns redirect() lands on /target", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/slot-redirect/"));
    await waitForHydration(page);

    await clickAndWaitFor(
      testId(page, "sr-link-plain"),
      testId(page, "sr-target"),
    );
    await expect(page).toHaveURL(/\/slot-redirect\/target$/);
  });

  test("soft navigation (Link click) to a slot that returns redirect() under loading() lands on /target", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/slot-redirect/"));
    await waitForHydration(page);

    await clickAndWaitFor(
      testId(page, "sr-link-streamed"),
      testId(page, "sr-target"),
    );
    await expect(page).toHaveURL(/\/slot-redirect\/target$/);
  });

  test("a page beside the redirecting slots still renders its slot", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/slot-redirect/"));
    await waitForHydration(page);

    await clickAndWaitFor(testId(page, "sr-link-aside"), testId(page, "sr-ok"));
    await expect(testId(page, "sr-aside")).toBeVisible();
  });

  test("an on-demand refresh whose slot redirects keeps the page stored before", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    const toggle = (redirects: boolean) =>
      page.request.get(
        f.url(`/slot-redirect/on-demand-trigger?redirect=${redirects ? 1 : 0}`),
      );
    const refresh = async () =>
      (
        await page.request.get(f.url("/slot-redirect/on-demand-trigger"))
      ).json();
    const stampOf = async () => {
      await page.goto(f.url("/slot-redirect/on-demand"));
      await waitForHydration(page);
      await expect(testId(page, "sr-od-page")).toBeVisible();
      return testId(page, "sr-od-stamp").textContent();
    };

    // Store the page, and read the stamp it froze.
    await toggle(false);
    expect(await refresh()).toMatchObject({ ok: true, status: "rendered" });
    const stamp = await stampOf();
    expect(stamp).toBeTruthy();

    // The slot redirects: the refresh reports the redirect, never a page.
    await toggle(true);
    expect(await refresh()).toMatchObject({
      ok: false,
      status: "render-failed",
      error: { status: 302, location: "/slot-redirect/target" },
    });

    // The page stored before still serves, with the stamp it froze.
    expect(await stampOf()).toBe(stamp);

    // A later refresh with no redirect replaces it.
    await toggle(false);
    expect(await refresh()).toMatchObject({ ok: true, status: "rendered" });
    expect(await stampOf()).not.toBe(stamp);
  });
}

// -- Dev mode ----------------------------------------------------------------
test.describe("slot handler redirect (dev mode)", () => {
  defineTests(useFixture({ root: "./e2e/test-app", mode: "dev" }));
});

// -- Production build --------------------------------------------------------
test.describe("slot handler redirect (production)", () => {
  defineTests(useFixture({ root: "./e2e/test-app", mode: "build" }));
});
