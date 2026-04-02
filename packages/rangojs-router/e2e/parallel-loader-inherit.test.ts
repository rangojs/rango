import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, testId } from "./helper";

/**
 * Regression test: loaders registered on a route via loader() DSL
 * should be accessible via useLoader() inside parallel() slots.
 *
 * Bug: useLoader() inside a parallel slot throws "data not found in context"
 * because parallel entries don't inherit parent route loaders during
 * segment resolution.
 */

test.describe("parallel-loader-inherit", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });

  test("route-level loader is accessible inside parallel slot via useLoader", async ({
    page,
  }) => {
    await page.goto(f.url("/parallel-loader-inherit"));
    await waitForHydration(page);

    await expect(testId(page, "parallel-loader-page")).toBeVisible();
    // The loader data should be available — not an error
    await expect(testId(page, "parallel-loader-data")).toHaveText(
      "route-level:inherited-data",
    );
  });
});

test.describe("parallel-loader-inherit (production)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "build",
  });

  test("route-level loader is accessible inside parallel slot in production", async ({
    page,
  }) => {
    await page.goto(f.url("/parallel-loader-inherit"));
    await waitForHydration(page);

    await expect(testId(page, "parallel-loader-page")).toBeVisible();
    await expect(testId(page, "parallel-loader-data")).toHaveText(
      "route-level:inherited-data",
    );
  });
});
