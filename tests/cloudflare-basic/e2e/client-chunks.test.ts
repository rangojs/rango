import { expect, test } from "@playwright/test";
import { useFixture, type Fixture } from "./fixture";
import { expectNoPageError, testId, waitForHydration } from "./helper";

/**
 * Default clientChunks strategy on an app/-rooted layout (issue #1022).
 * src/app/routes/split-hero and src/app/routes/split-gallery used to share one
 * app-routes group, and a group is the loading unit, so /app-root/hero
 * downloaded SplitGallery's code. The check reads the source of every script
 * the page loaded: the group chunks in production, the modules in dev.
 */
function clientChunksTests(f: Fixture) {
  test("app-rooted route does not download a sibling route's component", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/app-root/hero"));
    await waitForHydration(page);
    await expect(testId(page, "split-gallery")).toHaveCount(0);
    await testId(page, "split-hero-btn").click();
    await expect(testId(page, "split-hero-btn")).toHaveText(
      "split-hero count: 1",
    );

    const scripts = await page.evaluate(async () => {
      const urls = performance
        .getEntriesByType("resource")
        .map((e) => e.name)
        .filter(
          (n) =>
            n.startsWith(location.origin) &&
            /\.m?[jt]sx?$/.test(new URL(n).pathname),
        );
      return Promise.all(urls.map(async (u) => (await fetch(u)).text()));
    });
    expect(scripts.some((code) => code.includes("cf-app-split-hero"))).toBe(
      true,
    );
    expect(
      scripts.filter((code) => code.includes("cf-app-split-gallery")),
      "SplitGallery's code must not load on /app-root/hero",
    ).toEqual([]);
  });
}

test.describe("client chunks", () => {
  const f = useFixture({ root: ".", mode: "dev" });
  clientChunksTests(f);
});

test.describe("client chunks (production)", () => {
  const f = useFixture({ root: ".", mode: "build" });
  clientChunksTests(f);
});
