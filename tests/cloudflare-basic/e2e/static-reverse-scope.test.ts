import { type Page, expect, test } from "@playwright/test";
import { type Fixture, useFixture } from "./fixture";
import { waitForHydration, expectNoPageError, testId } from "./helper";

/**
 * A Static() layout or parallel slot bakes ctx.reverse(".name") in the module
 * that declares it, as the same segment resolves it live (dev).
 *
 * cloudflare-basic mounts include("/srs", ..., { name: "" }): a root-scoped
 * Static layout and slot above an account module at /:accountId that holds a
 * project module at /:projectId, with a Static layout in each and a Static
 * slot in the project's. Both modules name a route "settings". The build used
 * to resolve a nested layout's `.name` one module too high (the project
 * layout baked /acme/settings) and failed on the root layout's `.srsIndex`.
 */

const BASE = "/srs";

async function expectStaticLinks(page: Page) {
  await expect(testId(page, "srs-root-index-url")).toHaveText(BASE);
  await expect(testId(page, "srs-root-slot-url")).toHaveText(BASE);
  await expect(testId(page, "srs-account-settings-url")).toHaveText(
    `${BASE}/acme/settings`,
  );
  await expect(testId(page, "srs-project-settings-url")).toHaveText(
    `${BASE}/acme/web/settings`,
  );
  await expect(testId(page, "srs-project-slot-url")).toHaveText(
    `${BASE}/acme/web/settings`,
  );
}

function defineCases(f: Fixture) {
  test("project page document load: each Static segment links in its own module", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await page.goto(f.url(`${BASE}/acme/web/issues`));
    await waitForHydration(page);
    await expect(testId(page, "srs-project-issues")).toBeVisible();
    await expectStaticLinks(page);
  });

  test("navigation into the project page: each Static segment links in its own module", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await page.goto(f.url(`${BASE}/`));
    await waitForHydration(page);
    await expect(testId(page, "srs-root-index-url")).toHaveText(BASE);

    await testId(page, "srs-to-issues").click();
    await expect(page).toHaveURL(new RegExp(`${BASE}/acme/web/issues$`));
    await expect(testId(page, "srs-project-issues")).toBeVisible();
    await expectStaticLinks(page);
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
