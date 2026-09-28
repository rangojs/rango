import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError, blockPrefetch } from "./helper";

/**
 * An errorBoundary() and an intercept() declared in a routeless entry nested
 * in another one are found (issue #926). Fixture:
 * e2e/test-app/src/urls/cache.tsx, the /cache-test/nested-orphan routes: a
 * layout whose children are [path(index), path(throw), path(photo), cache(),
 * layout(Host, () => [errorBoundary(), intercept("@nestedOrphanModal",
 * photo)])]. For the routes before the marker, Host sits in the marker's
 * layout[], which sits in the shell's layout[]. Before, the lookups read one
 * level: the throw rendered the default fallback and the photo link loaded
 * the full page instead of the modal.
 */

function defineSpec(f: { url: (path: string) => string }): void {
  test("a route error renders the nested routeless layout's errorBoundary on a document request", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    const response = await page.goto(f.url("/cache-test/nested-orphan/throw"));
    expect(response?.status()).toBe(500);
    await expect(page.getByTestId("nested-orphan-error")).toBeVisible();
  });

  test("a route error renders the nested routeless layout's errorBoundary on a soft navigation", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await blockPrefetch(page);
    await page.goto(f.url("/cache-test/nested-orphan"));
    await waitForHydration(page);
    await page.getByTestId("nested-orphan-throw-link").click();
    await expect(page.getByTestId("nested-orphan-error")).toBeVisible();
  });

  test("an intercept declared in the nested routeless layout opens its modal", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await blockPrefetch(page);
    await page.goto(f.url("/cache-test/nested-orphan"));
    await waitForHydration(page);
    await page.getByTestId("nested-orphan-photo-link").click();
    await expect(page.getByTestId("nested-orphan-modal")).toHaveText("modal 1");
    await expect(page).toHaveURL(/\/cache-test\/nested-orphan\/photo\/1$/);
    // The origin page stays under the modal.
    await expect(page.getByTestId("nested-orphan-photo-link")).toBeVisible();
    await expect(page.getByTestId("nested-orphan-photo-page")).toHaveCount(0);
  });
}

test.describe("nested routeless entry lookups", () => {
  const f = useFixture({ root: "./e2e/test-app", mode: "dev" });
  defineSpec(f);
});

test.describe("nested routeless entry lookups (production)", () => {
  const f = useFixture({ root: "./e2e/test-app", mode: "build" });
  defineSpec(f);
});
