import { type Page, expect, test } from "@playwright/test";
import { type Fixture, useFixture } from "./fixture";
import { waitForHydration, expectNoPageError, testId } from "./helper";

/**
 * A Static() layout or slot bakes ctx.reverse(".name") in the module that
 * defines it, at every nesting depth, exactly as the same segment resolves
 * live.
 *
 * test-app mounts include("/static-scope", ..., { name: "" }) with an account
 * module at /acme holding a project module at /web; both name a route
 * "settings". The build used to resolve dot-local names from the def's name
 * prefix minus one segment, so the project layout and its slot baked the
 * account route (/static-scope/acme/settings) instead of the project one, and
 * the root-scoped layout threw "Unknown route" for ".staticScopeHome" at build.
 */

const BASE = "/static-scope";

async function expectRootLayout(page: Page) {
  await expect(testId(page, "srs-root-layout")).toHaveAttribute(
    "data-home-url",
    BASE,
  );
}

async function expectAccountLayout(page: Page) {
  await expect(testId(page, "srs-account-settings-url")).toHaveText(
    `${BASE}/acme/settings`,
  );
}

async function expectProjectScope(page: Page) {
  await expect(testId(page, "srs-project-settings-url")).toHaveText(
    `${BASE}/acme/web/settings`,
  );
  await expect(testId(page, "srs-project-slot")).toHaveText(
    `${BASE}/acme/web/settings`,
  );
}

function defineCases(f: Fixture) {
  test("a Static() layout and slot in a nested module bake their own module's route", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await page.goto(f.url(`${BASE}/acme/web/issues`));
    await waitForHydration(page);
    await expect(testId(page, "srs-project-issues")).toBeVisible();
    await expectRootLayout(page);
    await expectAccountLayout(page);
    await expectProjectScope(page);
  });

  test("a Static() layout at root scope bakes a root-scope dot name", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await page.goto(f.url(`${BASE}/`));
    await waitForHydration(page);
    await expect(testId(page, "srs-index")).toBeVisible();
    await expectRootLayout(page);
  });

  test("a partial navigation into the subtree keeps the same baked links", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await page.goto(f.url(`${BASE}/`));
    await waitForHydration(page);

    await testId(page, "srs-to-issues").click();
    await expect(page).toHaveURL(new RegExp(`${BASE}/acme/web/issues$`));
    await expect(testId(page, "srs-project-issues")).toBeVisible();
    await expectRootLayout(page);
    await expectAccountLayout(page);
    await expectProjectScope(page);
  });

  test("the project settings page keeps the same baked links", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await page.goto(f.url(`${BASE}/acme/web/settings`));
    await waitForHydration(page);
    await expect(testId(page, "srs-project-settings-page")).toBeVisible();
    await expectAccountLayout(page);
    await expectProjectScope(page);
  });
}

test.describe("static-reverse-scope", () => {
  const f = useFixture({ root: "./e2e/test-app", mode: "dev" });
  defineCases(f);
});

test.describe("static-reverse-scope (production)", () => {
  const f = useFixture({ root: "./e2e/test-app", mode: "build" });
  defineCases(f);
});
