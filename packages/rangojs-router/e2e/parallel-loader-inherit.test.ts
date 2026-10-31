import { expect, test, type Page } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, testId, expectNoPageError } from "./helper";

/**
 * Regression test: loaders registered on a route via loader() DSL
 * should be accessible via useLoader() inside parallel() slots,
 * even when the parallel is nested inside a child layout.
 *
 * Variants test the lookup:
 *   1. Without loading() — loaderData is on OutletProvider props
 *   2. With loading()    — loaderData is inside a LoaderBoundary element
 *   3. loading(false)    — no boundary: the layout's inherited copy of the
 *      loader is redundant and never sent (rango-t156)
 *
 * The copy the layout holds must be the same on every request of a route, or
 * the layout gains or loses a loader entry and remounts. Variants 4 and 5
 * keep local state in the layout across an action:
 *   4. loading(fallback) with the route's handler held: the action's payload
 *      carries the loader without the route segment
 *   5. loading(fallback, { ssr: false }): the document has no fallback and
 *      the action carries it
 */

/**
 * How many loader entries a document's Flight payload names. The routes
 * compared share every ancestor, so the difference is their own loaders.
 */
async function loaderEntries(page: Page, url: string): Promise<number> {
  const response = await page.request.get(url);
  expect(response.ok()).toBe(true);
  return (await response.text()).split("loaderId").length - 1;
}

async function loadingOffDropsTheCopy(page: Page, url: (p: string) => string) {
  using _ = expectNoPageError(page);
  await page.goto(url("/parallel-loader-inherit-loading-off"));
  await waitForHydration(page);

  await expect(testId(page, "parallel-loader-page-loading-off")).toBeVisible();
  await expect(testId(page, "parallel-loader-data")).toHaveText(
    "route-level:inherited-data",
  );

  const plain = await loaderEntries(page, url("/parallel-loader-inherit"));
  const withFallback = await loaderEntries(
    page,
    url("/parallel-loader-inherit-loading"),
  );
  // loading(fallback) sends the layout's copy beside the route's own.
  expect(withFallback).toBeGreaterThan(plain);
  // loading(false) sends only the route's own, as no loading() does.
  expect(
    await loaderEntries(page, url("/parallel-loader-inherit-loading-off")),
  ).toBe(plain);
}

async function actionKeepsTheLayout(page: Page, url: string) {
  using _ = expectNoPageError(page);
  await page.goto(url);
  await waitForHydration(page);

  const runs = testId(page, "inherit-probe-runs");
  await expect(runs).toHaveText(/^\d+$/);
  const before = Number(await runs.textContent());

  await testId(page, "inherit-probe-click").click();
  await expect(testId(page, "inherit-probe-clicks")).toHaveText("1");

  await testId(page, "inherit-probe-action").click();
  // The action's revalidation re-ran the loader and reached the slot.
  await expect
    .poll(async () => Number(await runs.textContent()))
    .toBeGreaterThan(before);
  // The layout kept its state: it did not remount.
  await expect(testId(page, "inherit-probe-clicks")).toHaveText("1");
  await expect(testId(page, "parallel-loader-error")).toHaveCount(0);
}

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

  test("loading(false): the slot reads the route's own copy, and the layout's is not sent", async ({
    page,
  }) => {
    await loadingOffDropsTheCopy(page, f.url);
  });

  test("loading() with the route's handler held: an action keeps the layout mounted", async ({
    page,
  }) => {
    await actionKeepsTheLayout(page, f.url("/parallel-loader-inherit-held"));
  });

  test("loading(..., { ssr: false }): an action after the document keeps the layout mounted", async ({
    page,
  }) => {
    await actionKeepsTheLayout(page, f.url("/parallel-loader-inherit-ssr-off"));
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

  test("loading(false): the slot reads the route's own copy, and the layout's is not sent, in production", async ({
    page,
  }) => {
    await loadingOffDropsTheCopy(page, f.url);
  });

  test("loading() with the route's handler held: an action keeps the layout mounted, in production", async ({
    page,
  }) => {
    await actionKeepsTheLayout(page, f.url("/parallel-loader-inherit-held"));
  });

  test("loading(..., { ssr: false }): an action after the document keeps the layout mounted, in production", async ({
    page,
  }) => {
    await actionKeepsTheLayout(page, f.url("/parallel-loader-inherit-ssr-off"));
  });
});
