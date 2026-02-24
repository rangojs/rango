import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import {
  waitForHydration,
  expectNoPageError,
  testId,
} from "./helper";

test.describe.configure({ mode: "serial" });

// -- Dev mode ----------------------------------------------------------------

test.describe("build-skip prerender (dev)", () => {
  const f = useFixture({
    root: ".",
    mode: "dev",
  });

  test("published article renders normally in dev", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/build-skip/published"));
    await waitForHydration(page);

    await expect(testId(page, "bs-article-title")).toContainText("published");
  });

  test("working static handler renders in dev", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/build-skip/working-static"));
    await waitForHydration(page);

    await expect(testId(page, "bs-working-static-title")).toContainText(
      "Working Static"
    );
  });
});

// -- Production build --------------------------------------------------------

test.describe("build-skip prerender (production)", () => {
  const f = useFixture({
    root: ".",
    mode: "build",
  });

  test("published article is pre-rendered and serves correctly", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/build-skip/published"));
    await waitForHydration(page);

    await expect(testId(page, "bs-article-title")).toContainText("published");
    await expect(testId(page, "bs-article-content")).toContainText(
      "Content for published"
    );
  });

  test("working static handler serves pre-rendered content", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/build-skip/working-static"));
    await waitForHydration(page);

    await expect(testId(page, "bs-working-static-title")).toContainText(
      "Working Static"
    );
  });

  test("working static handler timestamp is stable across reloads", async ({
    page,
  }) => {
    await page.goto(f.url("/build-skip/working-static"));
    await waitForHydration(page);

    const ts1 = await testId(page, "bs-working-static-timestamp").textContent();

    await page.reload();
    await waitForHydration(page);

    const ts2 = await testId(page, "bs-working-static-timestamp").textContent();

    // Truly pre-rendered: identical timestamp across reloads
    expect(ts1).toBe(ts2);
  });
});
