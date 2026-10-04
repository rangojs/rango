import { expect, test, type Page } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError, testId } from "./helper";

test.describe.configure({ mode: "serial" });

/**
 * A cached unit records the crumb of a dependency loader it reads, and the
 * page also reads that loader live (loaders stay live). On a HIT the crumb (a
 * per-run id) renders once, and it is the live run's, replacing the replayed
 * one. Runs against the real CFCacheStore.
 * - /loader-cache-dep: a loader with its own cache() awaits the dependency;
 *   an uncached sibling loader reads it too.
 * - /use-cache-dep: a "use cache" function reads the dependency; the handler
 *   reads it after the call (#928).
 * `stampId` renders the cached value, so an unchanged stamp marks a HIT.
 */
async function expectDepCrumbOnceAcrossHit(
  page: Page,
  url: (path: string) => string,
  route: { path: string; pageId: string; stampId: string },
) {
  const oneCrumb = /^Category [0-9a-f]{8}$/;
  const load = async () => {
    await page.goto(url(route.path));
    await waitForHydration(page);
    await expect(testId(page, route.pageId)).toBeVisible();
    return {
      stamp: (await testId(page, route.stampId).textContent()) ?? "",
      crumbs: await testId(page, "dep-crumbs").textContent(),
    };
  };

  const first = await load();
  expect(first.stamp).not.toBe("");
  expect(first.crumbs).toMatch(oneCrumb);

  // An unchanged stamp is the cached value: a HIT.
  let hit = first;
  await expect
    .poll(async () => (hit = await load()).stamp, {
      timeout: 15000,
      message: `Expected ${route.path} to serve a cache HIT`,
    })
    .toBe(first.stamp);
  expect(hit.crumbs).toMatch(oneCrumb);

  // Each HIT shows the live run's crumb, not the replayed copy.
  const next = await load();
  expect(next.stamp).toBe(first.stamp);
  expect(next.crumbs).toMatch(oneCrumb);
  expect(next.crumbs).not.toBe(hit.crumbs);
}

/**
 * /loader-ctx/:id: a DSL loader passes its own ctx to a "use cache" function
 * that pushes a crumb through it (#940). `lc-stamp` is the cached value: a HIT
 * repeats it and replays the crumb once; another id misses. Ids are unique per
 * run so the first load is a MISS.
 */
async function expectLoaderCtxCachedPerParams(
  page: Page,
  url: (path: string) => string,
) {
  const run = Math.random().toString(36).slice(2, 8);
  const [a, b] = [`a${run}`, `b${run}`];
  const load = async (id: string) => {
    await page.goto(url(`/loader-ctx/${id}`));
    await waitForHydration(page);
    await expect(testId(page, "loader-ctx-page")).toBeVisible();
    return {
      stamp: (await testId(page, "lc-stamp").textContent()) ?? "",
      crumbs: await testId(page, "dep-crumbs").textContent(),
    };
  };

  const first = await load(a);
  expect(first.stamp.startsWith(`${a} `)).toBe(true);
  expect(first.crumbs).toBe(`Item ${a}`);

  let hit = first;
  await expect
    .poll(async () => (hit = await load(a)).stamp, {
      timeout: 15000,
      message: 'Expected a "use cache" HIT for the loader ctx call',
    })
    .toBe(first.stamp);
  expect(hit.crumbs).toBe(`Item ${a}`);

  const other = await load(b);
  expect(other.stamp.startsWith(`${b} `)).toBe(true);
  expect(other.crumbs).toBe(`Item ${b}`);

  expect((await load(a)).stamp).toBe(first.stamp);
}

const LOADER_CACHE_DEP = {
  path: "/loader-cache-dep",
  pageId: "loader-cache-dep-page",
  stampId: "lcd-loaded-at",
};
const USE_CACHE_DEP = {
  path: "/use-cache-dep",
  pageId: "use-cache-dep-page",
  stampId: "ucd-cached-at",
};

test.describe("loader cache dependency crumbs", () => {
  // Isolated so other suites' CF cache state can't race the miss -> HIT
  // sequence.
  const f = useFixture({ root: ".", mode: "dev", isolatedServer: true });

  test("a dependency also read by a sibling loader shows its live crumb once on a HIT", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await expectDepCrumbOnceAcrossHit(page, (p) => f.url(p), LOADER_CACHE_DEP);
  });

  test("use cache: a loader also read by the handler shows its live crumb once on a HIT", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await expectDepCrumbOnceAcrossHit(page, (p) => f.url(p), USE_CACHE_DEP);
  });

  test("use cache: a DSL loader passing its ctx caches per params and replays its crumb once", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await expectLoaderCtxCachedPerParams(page, (p) => f.url(p));
  });
});

test.describe("loader cache dependency crumbs (production)", () => {
  const f = useFixture({ root: ".", mode: "build" });

  test("a dependency also read by a sibling loader shows its live crumb once on a HIT", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await expectDepCrumbOnceAcrossHit(page, (p) => f.url(p), LOADER_CACHE_DEP);
  });

  test("use cache: a loader also read by the handler shows its live crumb once on a HIT", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await expectDepCrumbOnceAcrossHit(page, (p) => f.url(p), USE_CACHE_DEP);
  });

  test("use cache: a DSL loader passing its ctx caches per params and replays its crumb once", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await expectLoaderCtxCachedPerParams(page, (p) => f.url(p));
  });
});
