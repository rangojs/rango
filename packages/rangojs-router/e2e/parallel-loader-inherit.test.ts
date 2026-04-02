import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, testId } from "./helper";

/**
 * Regression test: loaders registered on a route via loader() DSL
 * should be accessible via useLoader() inside parallel() slots,
 * even when the parallel is nested inside a child layout.
 *
 * Two variants test the lookup:
 *   1. Without loading() — loaderData is on OutletProvider props
 *   2. With loading()    — loaderData is inside a LoaderBoundary element
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
    await expect(testId(page, "parallel-loader-data")).toHaveText(
      "route-level:inherited-data",
    );
  });

  test("route-level loader with loading() is accessible inside parallel slot", async ({
    page,
  }) => {
    await page.goto(f.url("/parallel-loader-inherit-loading"));
    await waitForHydration(page);

    await expect(testId(page, "parallel-loader-page-loading")).toBeVisible();
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

  test("route-level loader with loading() is accessible in production", async ({
    page,
  }) => {
    await page.goto(f.url("/parallel-loader-inherit-loading"));
    await waitForHydration(page);

    await expect(testId(page, "parallel-loader-page-loading")).toBeVisible();
    await expect(testId(page, "parallel-loader-data")).toHaveText(
      "route-level:inherited-data",
    );
  });
});
