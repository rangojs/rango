import { type Page, expect, test } from "@playwright/test";
import { routerNavigate } from "@shared/e2e";
import { type Fixture, useFixture } from "./fixture";
import { waitForHydration, expectNoPageError, testId } from "./helper";

/**
 * A Static() layout or parallel slot bakes ctx.reverse(".name") in the module
 * that declares it, exactly as the same segment resolves it live.
 *
 * test-app mounts include("/static-scope", ..., { name: "" }) — a transparent
 * include, so its Static root-scope layout and parallel slot bake with no name
 * prefix — and below it the outer module (prefix "outer") holds the inner
 * module (prefix "outer.inner"). The outer and the inner module both name a
 * route "settings", so a bake that resolves one include too high bakes the
 * outer module's URL for the inner layout and the inner slot (it did:
 * /static-scope/outer/settings instead of
 * /static-scope/outer/inner/settings), and a root-scope bake used to throw
 * Unknown route for ".staticScopeHome" — the layout's and the slot's alike.
 */

const BASE = "/static-scope";

async function expectRootScopeLink(page: Page) {
  await expect(testId(page, "srs-root-home")).toHaveText(`${BASE}/home`);
  // A root-scope parallel slot bakes the same link as its layout.
  await expect(testId(page, "srs-root-slot-home")).toHaveText(`${BASE}/home`);
}

async function expectInnerLinks(page: Page) {
  await expect(testId(page, "srs-outer-settings")).toHaveText(
    `${BASE}/outer/settings`,
  );
  await expect(testId(page, "srs-inner-settings")).toHaveText(
    `${BASE}/outer/inner/settings`,
  );
  await expect(testId(page, "srs-slot-settings")).toHaveText(
    `${BASE}/outer/inner/settings`,
  );
}

function defineCases(f: Fixture) {
  test("root-scope Static layout links at root scope", async ({ page }) => {
    using _ = expectNoPageError(page);
    await page.goto(f.url(`${BASE}/home`));
    await waitForHydration(page);
    await expect(testId(page, "srs-home-page")).toBeVisible();
    await expectRootScopeLink(page);
  });

  test("document load: the inner Static layout and slot link to the inner module", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await page.goto(f.url(`${BASE}/outer/inner/settings`));
    await waitForHydration(page);
    await expect(testId(page, "srs-inner-settings-page")).toBeVisible();
    await expect(testId(page, "srs-inner-slot")).toBeVisible();
    await expectRootScopeLink(page);
    await expectInnerLinks(page);
  });

  test("document load: the outer Static layout links to the outer module", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await page.goto(f.url(`${BASE}/outer/settings`));
    await waitForHydration(page);
    await expect(testId(page, "srs-outer-settings-page")).toBeVisible();
    await expect(testId(page, "srs-outer-settings")).toHaveText(
      `${BASE}/outer/settings`,
    );
  });

  test("client navigation: the inner Static layout and slot link to the inner module", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await page.goto(f.url(`${BASE}/home`));
    await waitForHydration(page);

    await routerNavigate(page, f.url(`${BASE}/outer/inner/settings`));
    await expect(testId(page, "srs-inner-settings-page")).toBeVisible();
    await expect(testId(page, "srs-inner-slot")).toBeVisible();
    await expectInnerLinks(page);
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
