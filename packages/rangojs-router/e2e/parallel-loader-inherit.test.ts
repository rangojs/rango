import { expect, test, type Page } from "@playwright/test";
import { runParallelLoaderInheritHeldTests } from "@shared/e2e";
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
 *      loader is redundant and never sent, on the document, an action or a
 *      same-route navigation (rango-t156)
 *
 * The copy the layout holds must be the same on every request of a route, or
 * the layout gains or loses a loader entry and remounts. Variants 3 to 7
 * keep local state in the layout across an action:
 *   4. loading(fallback) with the route's handler held: the action's payload
 *      carries the loader without the route segment
 *   5. loading(fallback, { ssr: false }): the document has no fallback and
 *      the action carries it
 *   6, 7. the route's loader held, with no loading() and with loading(false):
 *      tests/shared-e2e/src/parallel-loader-inherit-held-scenario.ts, which
 *      cloudflare-basic runs too
 */

/**
 * The ParallelInheritLoader segment ids a Flight payload (a document's inline
 * one or an RSC response) names: the route's own `<route>D0.<$$id>` and, when
 * sent, the layout's copy `<route>L0D0.<$$id>`. Every loader id ends in
 * `#<export name>` in dev and production.
 */
function inheritLoaderSegmentIds(body: string): Set<string> {
  return new Set(
    body.match(/[A-Z][A-Z0-9]*D\d+\.[^"\\\s]*#ParallelInheritLoader\b/g) ?? [],
  );
}

async function documentLoaderSegmentIds(
  page: Page,
  url: string,
): Promise<Set<string>> {
  const response = await page.request.get(url);
  expect(response.ok()).toBe(true);
  return inheritLoaderSegmentIds(await response.text());
}

async function loadingOffNeverSendsTheCopy(
  page: Page,
  url: (p: string) => string,
) {
  using _ = expectNoPageError(page);
  // loading(fallback) sends the layout's copy beside the route's own; no
  // loading() sends only the route's own.
  expect(
    (
      await documentLoaderSegmentIds(
        page,
        url("/parallel-loader-inherit-loading"),
      )
    ).size,
  ).toBe(2);
  expect(
    (await documentLoaderSegmentIds(page, url("/parallel-loader-inherit")))
      .size,
  ).toBe(1);

  // Every Flight payload of this route the page receives from here on: the
  // action's and the navigation's.
  const path = "/parallel-loader-inherit-loading-off";
  const bodies: Promise<string>[] = [];
  page.on("response", (response) => {
    if (
      response.url().includes(path) &&
      response.headers()["content-type"]?.includes("text/x-component")
    ) {
      bodies.push(response.text().catch(() => ""));
    }
  });

  const ids = await documentLoaderSegmentIds(page, url(path));
  // loading(false) sends only the route's own, as no loading() does.
  expect(ids.size).toBe(1);

  await page.goto(url(path));
  await waitForHydration(page);
  await expect(testId(page, "parallel-loader-page-loading-off")).toBeVisible();
  await expect(testId(page, "parallel-loader-data")).toHaveText(
    "route-level:inherited-data",
  );
  await testId(page, "inherit-probe-click").click();
  await expect(testId(page, "inherit-probe-clicks")).toHaveText("1");

  const renders = async () =>
    Number(await testId(page, "pli-renders").textContent());
  const before = await renders();
  await testId(page, "inherit-probe-action").click();
  await expect.poll(renders).toBeGreaterThan(before);
  await expect(testId(page, "inherit-probe-clicks")).toHaveText("1");

  await testId(page, "pli-nav").click();
  await expect(testId(page, "pli-x")).toHaveText("2");
  await expect(testId(page, "inherit-probe-clicks")).toHaveText("1");
  await expect(testId(page, "parallel-loader-data")).toHaveText(
    "route-level:inherited-data",
  );

  // The action and the navigation re-run the route's loader and name its own
  // segment, and no other.
  expect(bodies.length).toBeGreaterThanOrEqual(2);
  for (const body of await Promise.all(bodies)) {
    expect(inheritLoaderSegmentIds(body)).toEqual(ids);
  }
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

  test("loading(false): the slot reads the route's own copy, and the layout's is not sent on the document, an action or a navigation", async ({
    page,
  }) => {
    await loadingOffNeverSendsTheCopy(page, f.url);
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

  runParallelLoaderInheritHeldTests({ url: (pathname) => f.url(pathname) });
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

  test("loading(false): the slot reads the route's own copy, and the layout's is not sent on the document, an action or a navigation, in production", async ({
    page,
  }) => {
    await loadingOffNeverSendsTheCopy(page, f.url);
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

  runParallelLoaderInheritHeldTests({ url: (pathname) => f.url(pathname) });
});
