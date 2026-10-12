import { expect, test, type Page } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError, testId } from "./helper";

/**
 * Hidden include-scope names (#1104). A route behind an unnamed include has an
 * internal key ($prefix_*); the trie carries the key build discovery gave it and
 * the runtime must register the same one. Fixture:
 * src/pages/include-scope.tsx.
 *
 * - an unnamed include inside an unnamed include serves its route (it used to
 *   404 whenever the trie was live);
 * - an unnamed include beside a transparent `{ name: "" }` include that holds
 *   another unnamed include: both name a route "page", and each URL renders its
 *   own handler (the two used to share one key).
 */

async function expectPage(page: Page, url: string, testid: string) {
  const response = await page.goto(url);
  expect(response?.status()).toBe(200);
  await waitForHydration(page);
  await expect(testId(page, testid)).toBeVisible();
}

function defineSpec(f: { url: (path: string) => string }): void {
  test("an unnamed include nested in an unnamed include serves its route", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await expectPage(
      page,
      f.url("/nested-unnamed/login"),
      "include-scope-login",
    );
  });

  test("same-named routes beside and behind a transparent include render their own handlers", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await expectPage(page, f.url("/include-scope/x"), "include-scope-x");
    await expectPage(page, f.url("/include-scope/z"), "include-scope-z");
    await expect(testId(page, "include-scope-x")).toHaveCount(0);
  });
}

test.describe("hidden include-scope names (dev)", () => {
  const f = useFixture({ root: ".", mode: "dev" });
  test.setTimeout(30_000);
  defineSpec(f);
});

test.describe("hidden include-scope names (production)", () => {
  const f = useFixture({ root: ".", mode: "build" });
  test.setTimeout(120_000);
  defineSpec(f);
});
