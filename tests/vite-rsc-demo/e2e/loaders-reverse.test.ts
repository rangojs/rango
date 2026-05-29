import { expect, test } from "@playwright/test";
import { test as devTest, devURL } from "./dev-fixture";
import { useFixture } from "./fixture";
import { expectNoPageError, waitForHydration } from "./helper";

const expectedUrls = {
  "reverse-local-index": "/loaders",
  "reverse-local-stats": "/loaders/stats",
  "reverse-global-home": "/",
  "reverse-global-blog": "/blog",
  "reverse-blog-post": "/blog/hello-world",
} as const;

devTest.describe("loader-ctx-reverse", () => {
  devTest(
    "renders URLs resolved by ctx.reverse from inside a loader",
    async ({ page, devServerURL }) => {
      using _ = expectNoPageError(page);

      await page.goto(devURL(devServerURL, "/loaders/reverse"));
      await waitForHydration(page);

      for (const [testId, expected] of Object.entries(expectedUrls)) {
        await expect(page.locator(`[data-testid="${testId}"]`)).toHaveText(
          expected,
          { timeout: 10000 },
        );
      }
    },
  );
});

test.describe("loader-ctx-reverse (production)", () => {
  const f = useFixture({ root: ".", mode: "build" });

  test.setTimeout(120000);

  test("renders URLs resolved by ctx.reverse from inside a loader", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/loaders/reverse"));
    await waitForHydration(page);

    for (const [testId, expected] of Object.entries(expectedUrls)) {
      await expect(page.locator(`[data-testid="${testId}"]`)).toHaveText(
        expected,
        { timeout: 10000 },
      );
    }
  });
});
