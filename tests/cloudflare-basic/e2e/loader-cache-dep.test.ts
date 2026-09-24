import { expect, test, type Page } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError, testId } from "./helper";

test.describe.configure({ mode: "serial" });

/**
 * /loader-cache-dep: a loader with its own cache() awaits a dependency that an
 * uncached sibling loader also reads. On a loader-cache HIT the cached entry
 * replays the dependency's crumb and the sibling still runs the dependency
 * (loaders stay live): the crumb (a per-run id) renders once, and it is the
 * live run's, replacing the replayed one. Runs against the real CFCacheStore.
 */
async function expectDepCrumbOnceAcrossLoaderCacheHit(
  page: Page,
  url: (path: string) => string,
) {
  const oneCrumb = /^Category [0-9a-f]{8}$/;
  const load = async () => {
    await page.goto(url("/loader-cache-dep"));
    await waitForHydration(page);
    await expect(testId(page, "loader-cache-dep-page")).toBeVisible();
    return {
      stamp: (await testId(page, "lcd-loaded-at").textContent()) ?? "",
      crumbs: await testId(page, "dep-crumbs").textContent(),
    };
  };

  const first = await load();
  expect(first.stamp).not.toBe("");
  expect(first.crumbs).toMatch(oneCrumb);

  // An unchanged stamp is the cached loader value: a loader-cache HIT.
  let hit = first;
  await expect
    .poll(async () => (hit = await load()).stamp, {
      timeout: 15000,
      message: "Expected /loader-cache-dep to serve a loader-cache HIT",
    })
    .toBe(first.stamp);
  expect(hit.crumbs).toMatch(oneCrumb);

  // Each HIT shows the live run's crumb, not the replayed copy.
  const next = await load();
  expect(next.stamp).toBe(first.stamp);
  expect(next.crumbs).toMatch(oneCrumb);
  expect(next.crumbs).not.toBe(hit.crumbs);
}

test.describe("loader cache dependency crumbs", () => {
  // Isolated so other suites' CF cache state can't race the miss -> HIT
  // sequence.
  const f = useFixture({ root: ".", mode: "dev", isolatedServer: true });

  test("a dependency also read by a sibling loader shows its live crumb once on a HIT", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await expectDepCrumbOnceAcrossLoaderCacheHit(page, (p) => f.url(p));
  });
});

test.describe("loader cache dependency crumbs (production)", () => {
  const f = useFixture({ root: ".", mode: "build" });

  test("a dependency also read by a sibling loader shows its live crumb once on a HIT", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await expectDepCrumbOnceAcrossLoaderCacheHit(page, (p) => f.url(p));
  });
});
