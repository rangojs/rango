import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError, testId } from "./helper";

/**
 * Tests for root-level (orphan) loader.
 *
 * Verifies that loader() placed at the root of urls() (not inside a path's
 * children) works correctly and can be consumed via ctx.use() in path handlers.
 */

test.describe("root-loader (dev)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });

  test("root-level loader data is available via ctx.use()", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/root-loader"));
    await waitForHydration(page);

    await expect(testId(page, "root-loader-page")).toBeVisible();
    await expect(testId(page, "root-loader-source")).toHaveText(
      "root-level-loader",
    );
    await expect(testId(page, "root-loader-timestamp")).not.toBeEmpty();
  });
});

test.describe("root-loader (production)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "build",
  });

  test.setTimeout(120000);

  test("root-level loader data is available via ctx.use() in production", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/root-loader"));
    await waitForHydration(page);

    await expect(testId(page, "root-loader-page")).toBeVisible();
    await expect(testId(page, "root-loader-source")).toHaveText(
      "root-level-loader",
    );
    await expect(testId(page, "root-loader-timestamp")).not.toBeEmpty();
  });
});
