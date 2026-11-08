import { expect, test } from "@playwright/test";
import { useFixture, type Fixture } from "./fixture";
import { waitForHydration, testId, clickAndWaitFor } from "./helper";

// A `throw redirect()` from a server COMPONENT (mirrors the router e2e app's
// component-redirect.test.ts, rango-t450): the throw lands inside the Flight
// render, so a client navigation carries the target in the error row's digest
// and the router's own boundary replace-navigates, while a document request
// answers a real 3xx.
//
// Fixture: src/component-redirect.tsx.
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
    await page.goto(f.url("/component-redirect/after-await"));
    await waitForHydration(page);

    await expect(testId(page, "cr-login")).toBeVisible();
    await expect(page).toHaveURL(/\/component-redirect\/login$/);
  });
}

test.describe("component-redirect (dev)", () => {
  defineTests(useFixture({ root: ".", mode: "dev" }));
});

test.describe("component-redirect (production)", () => {
  defineTests(useFixture({ root: ".", mode: "build" }));
});
