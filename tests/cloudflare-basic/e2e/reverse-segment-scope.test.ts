import { type Page, expect, test } from "@playwright/test";
import { type Fixture, useFixture } from "./fixture";
import { waitForHydration, expectNoPageError, testId } from "./helper";

/**
 * A segment's ctx.reverse(".name") resolves in the module that defines it.
 *
 * cloudflare-basic mounts include("/rss", ..., { name: "rss" })
 * with an account module at /:accountId that holds a project module at
 * /:projectId; both name a route "settings". The account layout's
 * `.settings` must link to the account route on the project's pages too
 * (it used to resolve from the matched project route and link to
 * /acme/web/settings). The project route's own `.settings` still links to
 * the project route.
 */

const BASE = "/rss";

async function expectAccountLink(page: Page) {
  await expect(testId(page, "rss-account-settings-url")).toHaveText(
    `${BASE}/acme/settings`,
  );
  // A component the layout hands its ctx to resolves in the layout's module.
  await expect(testId(page, "rss-account-child-url")).toHaveText(
    `${BASE}/acme/settings`,
  );
}

function defineCases(f: Fixture) {
  test("account page: the account layout links to the account route", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await page.goto(f.url(`${BASE}/acme/settings`));
    await waitForHydration(page);
    await expect(testId(page, "rss-account-settings-page")).toBeVisible();
    await expectAccountLink(page);
  });

  test("project page document load: the account layout still links to the account route", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await page.goto(f.url(`${BASE}/acme/web/issues`));
    await waitForHydration(page);
    await expect(testId(page, "rss-project-issues")).toBeVisible();
    await expectAccountLink(page);
    // The matched route's own dot name resolves in its module.
    await expect(testId(page, "rss-project-settings-url")).toHaveText(
      `${BASE}/acme/web/settings`,
    );

    await testId(page, "rss-account-settings-link").click();
    await expect(page).toHaveURL(new RegExp(`${BASE}/acme/settings$`));
    await expect(testId(page, "rss-account-settings-page")).toBeVisible();
  });

  test("navigation into the project page: the account layout links to the account route", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await page.goto(f.url(`${BASE}/`));
    await waitForHydration(page);

    await testId(page, "rss-to-issues").click();
    await expect(page).toHaveURL(new RegExp(`${BASE}/acme/web/issues$`));
    await expect(testId(page, "rss-project-issues")).toBeVisible();
    await expectAccountLink(page);
    await expect(testId(page, "rss-project-settings-url")).toHaveText(
      `${BASE}/acme/web/settings`,
    );
  });
}

test.describe("reverse-segment-scope-cf", () => {
  const f = useFixture({ root: ".", mode: "dev" });
  defineCases(f);
});

test.describe("reverse-segment-scope-cf (production)", () => {
  const f = useFixture({ root: ".", mode: "build" });
  defineCases(f);
});
