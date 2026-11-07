import { type Page, expect, test } from "@playwright/test";
import { type Fixture, useFixture } from "./fixture";
import { waitForHydration, expectNoPageError, testId } from "./helper";

/**
 * A Static() layout or parallel slot bakes `ctx.reverse(".name")` in the module
 * that declares it, exactly as the same segment renders live.
 *
 * cloudflare-basic mounts include("/srs", ..., { name: "" }) — a transparent
 * include, so the module's own layout sits at root scope with no name prefix —
 * over an account module at /acme holding a project module at /acme/web. Both
 * name a route "settings", so every depth has a different right answer. Before
 * the fix the bake passed the def's include prefix as a route name, which
 * strips its last segment: the project layout linked to /srs/acme/settings, and
 * the root layout threw `Unknown route: ".srsHome"` at build.
 */

const BASE = "/srs";

async function expectBakedLinks(page: Page) {
  // Root scope: `.srsHome` has no include prefix to resolve in.
  await expect(testId(page, "srs-root-home")).toHaveText(BASE);
  // account module.
  await expect(testId(page, "srs-account-settings")).toHaveText(
    `${BASE}/acme/settings`,
  );
  // project module, nested in account.
  await expect(testId(page, "srs-project-settings")).toHaveText(
    `${BASE}/acme/web/settings`,
  );
  // the parallel slot declared in the project module.
  await expect(testId(page, "srs-slot-settings")).toHaveText(
    `${BASE}/acme/web/settings`,
  );
}

function defineCases(f: Fixture) {
  test("project page: every baked layout and slot links inside its own module", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await page.goto(f.url(`${BASE}/acme/web/issues`));
    await waitForHydration(page);
    await expect(testId(page, "srs-project-issues")).toBeVisible();
    await expectBakedLinks(page);
  });

  test("account page: the account layout links to the account route", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await page.goto(f.url(`${BASE}/acme/settings`));
    await waitForHydration(page);
    await expect(testId(page, "srs-account-settings-page")).toBeVisible();
    await expect(testId(page, "srs-root-home")).toHaveText(BASE);
    await expect(testId(page, "srs-account-settings")).toHaveText(
      `${BASE}/acme/settings`,
    );
    await expect(testId(page, "srs-project-layout")).toHaveCount(0);
  });

  test("a navigation into the project page keeps the baked links", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await page.goto(f.url(`${BASE}/`));
    await waitForHydration(page);

    await testId(page, "srs-to-issues").click();
    await expect(page).toHaveURL(new RegExp(`${BASE}/acme/web/issues$`));
    await expect(testId(page, "srs-project-issues")).toBeVisible();
    await expectBakedLinks(page);
  });
}

test.describe("static-reverse-scope-cf", () => {
  const f = useFixture({ root: ".", mode: "dev" });
  defineCases(f);
});

test.describe("static-reverse-scope-cf (production)", () => {
  const f = useFixture({ root: ".", mode: "build" });
  defineCases(f);
});
