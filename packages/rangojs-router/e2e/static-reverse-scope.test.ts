import { expect, test } from "@playwright/test";
import { type Fixture, useFixture } from "./fixture";
import { waitForHydration, expectNoPageError, testId } from "./helper";

/**
 * A Static() layout or parallel slot bakes `ctx.reverse(".name")` in the
 * include scope it was mounted in, exactly as the same layout resolves it
 * live — at every nesting depth, the root included.
 *
 * test-app mounts include("/static-reverse", ...) with no name, so the root
 * Static layout is at root scope. Below it: an account module at /:accountId
 * with a Static layout, holding a project module at /:projectId with a Static
 * layout and a Static @aside slot. Both modules name a route "settings"; the
 * account also names "billing".
 *
 * In production the root, account and project Static segments come from the
 * build artifact (the bake), in dev the same handlers run live. The expected
 * URLs are the live ones, so this pins build/live parity in both modes.
 */

const BASE = "/static-reverse";

function defineCases(f: Fixture) {
  test("a nested Static layout and slot link inside their own module", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await page.goto(f.url(`${BASE}/acme/web/issues`));
    await waitForHydration(page);
    await expect(testId(page, "srs-project-issues")).toBeVisible();

    // Two includes deep: the project's own settings route, not the account's
    // (before, the bake resolved one module up and linked /acme/settings).
    await expect(testId(page, "srs-project-settings")).toHaveText(
      `${BASE}/acme/web/settings`,
    );
    await expect(testId(page, "srs-project-slot")).toHaveText(
      `${BASE}/acme/web/settings`,
    );
    // The walk-up to the enclosing account include still resolves.
    await expect(testId(page, "srs-project-billing")).toHaveText(
      `${BASE}/acme/billing`,
    );

    // One include deep: the account's own settings route.
    await expect(testId(page, "srs-account-settings")).toHaveText(
      `${BASE}/acme/settings`,
    );

    // Root scope: the bare-name fallback (before, the bake threw
    // Unknown route: ".staticReverseHome" and the build failed).
    await expect(testId(page, "srs-root-home")).toHaveText(BASE);
  });

  test("the link a nested Static layout renders reaches its own route", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await page.goto(f.url(`${BASE}/acme/web/issues`));
    await waitForHydration(page);

    await testId(page, "srs-project-settings-link").click();
    await expect(page).toHaveURL(new RegExp(`${BASE}/acme/web/settings$`));
    await expect(testId(page, "srs-project-settings-page")).toBeVisible();
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
