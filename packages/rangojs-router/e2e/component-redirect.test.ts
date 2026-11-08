import { expect, test } from "@playwright/test";
import { useFixture, type Fixture } from "./fixture";
import { waitForHydration, testId, clickAndWaitFor } from "./helper";

// A `throw redirect()` from a server COMPONENT (not a handler, not a loader).
//
// The throw happens inside the Flight render, so by the time it lands a
// navigation's headers and first rows have left the server and no HTTP status
// can answer it. The target rides the error row's digest instead
// (src/redirect-signal.ts) and the router's own client boundary turns it into
// the loader lane's replace-navigation; a document request, which has flushed
// nothing, answers the same 3xx a handler's throw does.
//
// Fixture: e2e/test-app/src/urls/component-redirect.tsx. The signed-out
// session read is a tick, so the "after an await" case really does throw after
// the shell: the sync case alone would not pin the streaming lane.
function defineTests(f: Fixture) {
  test("a click to a component that redirects after an await lands on /login", async ({
    page,
  }) => {
    await page.goto(f.url("/component-redirect"));
    await waitForHydration(page);

    await clickAndWaitFor(
      testId(page, "cr-link-await"),
      testId(page, "cr-login"),
    );
    await expect(page).toHaveURL(/\/component-redirect\/login$/);
    await expect(page.getByText("Internal Server Error")).toHaveCount(0);
  });

  test("a click to a component that redirects before any await lands on /login", async ({
    page,
  }) => {
    await page.goto(f.url("/component-redirect"));
    await waitForHydration(page);

    await clickAndWaitFor(
      testId(page, "cr-link-sync"),
      testId(page, "cr-login"),
    );
    await expect(page).toHaveURL(/\/component-redirect\/login$/);
    await expect(page.getByText("Internal Server Error")).toHaveCount(0);
  });

  test("opening the URL directly lands on /login", async ({ page }) => {
    // A document request has flushed nothing when the shell fails, so it
    // answers the same 3xx a handler's throw does: pin the status, not only
    // where the browser ends up (a 200 whose client replaces would land there
    // too, and a crawler or a no-JS client would not).
    const answer = await page.request.get(
      f.url("/component-redirect/after-await"),
      { maxRedirects: 0 },
    );
    expect(answer.status()).toBe(302);
    expect(answer.headers()["location"]).toMatch(
      /\/component-redirect\/login$/,
    );

    await page.goto(f.url("/component-redirect/after-await"));
    await waitForHydration(page);

    await expect(testId(page, "cr-login")).toBeVisible();
    await expect(page).toHaveURL(/\/component-redirect\/login$/);
  });
}

// -- Dev mode ----------------------------------------------------------------
test.describe("component redirect (dev mode)", () => {
  defineTests(useFixture({ root: "./e2e/test-app", mode: "dev" }));
});

// -- Production build --------------------------------------------------------
test.describe("component redirect (production build)", () => {
  defineTests(useFixture({ root: "./e2e/test-app", mode: "build" }));
});
