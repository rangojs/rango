import { expect, test, type Page } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError, goBack } from "./helper";

/**
 * /use-cache-test/dep-crumbs: a "use cache" function reads a loader that the
 * handler also reads live after it. The loader's crumb (a per-run id) renders
 * once on the MISS and once on each HIT, where it is the live run's crumb,
 * replacing the replayed one (#928).
 */
async function expectUseCacheDepCrumbOnceAcrossHit(
  page: Page,
  url: (path: string) => string,
) {
  const oneCrumb = /^Category [0-9a-f]{8}$/;
  const load = async () => {
    await page.goto(url("/use-cache-test/dep-crumbs"));
    await waitForHydration(page);
    await expect(page.getByTestId("use-cache-dep-page")).toBeVisible();
    return {
      stamp: await page.getByTestId("use-cache-dep-ts").textContent(),
      crumbs: await page.getByTestId("dep-crumbs").textContent(),
    };
  };

  const first = await load();
  expect(first.crumbs).toMatch(oneCrumb);

  // An unchanged stamp is the cached value: a "use cache" HIT.
  let hit = first;
  await expect
    .poll(async () => (hit = await load()).stamp, {
      timeout: 8000,
      message: 'Expected a "use cache" HIT (unchanged stamp)',
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
 * /use-cache-test/loader-ctx/:id: a DSL loader passes its own ctx to a "use
 * cache" function that pushes a crumb through it (#940). The stamp is the
 * cached value: a HIT repeats it and replays the crumb once; another id
 * misses. Ids are unique per run so the first load is a MISS.
 */
async function expectLoaderCtxCachedPerParams(
  page: Page,
  url: (path: string) => string,
) {
  const run = Math.random().toString(36).slice(2, 8);
  const [a, b] = [`a${run}`, `b${run}`];
  const load = async (id: string) => {
    await page.goto(url(`/use-cache-test/loader-ctx/${id}`));
    await waitForHydration(page);
    await expect(page.getByTestId("use-cache-loader-ctx-page")).toBeVisible();
    return {
      stamp:
        (await page.getByTestId("use-cache-loader-ctx-stamp").textContent()) ??
        "",
      crumbs: await page.getByTestId("dep-crumbs").textContent(),
    };
  };

  const first = await load(a);
  expect(first.stamp.startsWith(`${a} `)).toBe(true);
  expect(first.crumbs).toBe(`Item ${a}`);

  let hit = first;
  await expect
    .poll(async () => (hit = await load(a)).stamp, {
      timeout: 8000,
      message: 'Expected a "use cache" HIT for the loader ctx call',
    })
    .toBe(first.stamp);
  expect(hit.crumbs).toBe(`Item ${a}`);

  const other = await load(b);
  expect(other.stamp.startsWith(`${b} `)).toBe(true);
  expect(other.crumbs).toBe(`Item ${b}`);

  expect((await load(a)).stamp).toBe(first.stamp);
}

/**
 * Tests for the "use cache" directive — context/handles, inline use cache,
 * and intercept handler caching.
 *
 * Validates tainted ctx exclusion from cache keys, handle capture/replay,
 * cached function returning React nodes, cached function inside loaders,
 * inline "use cache" in path handlers and layouts, and intercept handler
 * cache isolation.
 *
 * Strategy: cached functions embed Date.now() + Math.random() in their
 * return values. On cache hit the values are identical to the first call.
 * On cache miss they differ.
 */

// ============================================================================
// Dev mode tests
// ============================================================================

test.describe("use-cache handles", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });

  test("tainted ctx is excluded from cache key and handles are replayed", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // First visit — cache miss, breadcrumb handle is pushed
    await page.goto(f.url("/use-cache-test/with-handles"));
    await waitForHydration(page);

    await expect(page.getByTestId("use-cache-handles-page")).toBeVisible();
    const cachedTs1 = await page
      .getByTestId("use-cache-handles-ts")
      .textContent();
    const serverTs1 = await page
      .getByTestId("use-cache-handles-server-ts")
      .textContent();

    // Breadcrumb should appear (RootLayout pushes "Home", fetchWithBreadcrumbs pushes "Cached Page")
    const breadcrumbs = page.getByTestId("breadcrumbs");
    await expect(breadcrumbs).toBeVisible();
    await expect(breadcrumbs).toContainText("Cached Page");

    // Navigate away
    await page.goto(f.url("/"));
    await waitForHydration(page);

    // Second visit — cache hit, handles should be replayed
    await page.goto(f.url("/use-cache-test/with-handles"));
    await waitForHydration(page);

    const cachedTs2 = await page
      .getByTestId("use-cache-handles-ts")
      .textContent();
    const serverTs2 = await page
      .getByTestId("use-cache-handles-server-ts")
      .textContent();

    // Cached fn resolved from cache (same timestamp)
    expect(cachedTs2).toBe(cachedTs1);
    // Handler ran fresh (server time advanced)
    expect(Number(serverTs2)).toBeGreaterThan(Number(serverTs1));

    // Breadcrumb should still appear (handle replay from cache)
    await expect(breadcrumbs).toBeVisible();
    await expect(breadcrumbs).toContainText("Cached Page");
  });

  test("a loader read inside the cached function and live shows its live crumb once on a HIT", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await expectUseCacheDepCrumbOnceAcrossHit(page, (p) => f.url(p));
  });

  test("a DSL loader passing its ctx caches per params and replays its crumb once", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await expectLoaderCtxCachedPerParams(page, (p) => f.url(p));
  });

  test("cached function returning React node serializes through cache", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // First visit — cache miss, 200ms internal await, JSX serialized via Flight
    await page.goto(f.url("/use-cache-test/cached-node"));
    await waitForHydration(page);

    await expect(page.getByTestId("use-cache-node-page")).toBeVisible({
      timeout: 10000,
    });
    const cachedTs1 = await page.getByTestId("cached-node-ts").textContent();
    const cachedRand1 = await page
      .getByTestId("cached-node-rand")
      .textContent();
    const serverTs1 = await page
      .getByTestId("use-cache-node-server-ts")
      .textContent();

    expect(cachedTs1).toMatch(/^\d+$/);
    expect(cachedRand1).toMatch(/^0\.\d+$/);

    // Navigate away
    await page.goto(f.url("/"));
    await waitForHydration(page);

    // Second visit — cache hit, JSX deserialized from cache
    await page.goto(f.url("/use-cache-test/cached-node"));
    await waitForHydration(page);

    await expect(page.getByTestId("use-cache-node-page")).toBeVisible();
    const cachedTs2 = await page.getByTestId("cached-node-ts").textContent();
    const cachedRand2 = await page
      .getByTestId("cached-node-rand")
      .textContent();
    const serverTs2 = await page
      .getByTestId("use-cache-node-server-ts")
      .textContent();

    // Cached JSX is identical (RSC Flight roundtrip preserved the React elements)
    expect(cachedTs2).toBe(cachedTs1);
    expect(cachedRand2).toBe(cachedRand1);
    // Handler ran fresh (server time advanced)
    expect(Number(serverTs2)).toBeGreaterThan(Number(serverTs1));
  });

  test("inline use cache in path handler: breadcrumbs captured and replayed", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // First visit — cache miss, handler runs, breadcrumb pushed
    await page.goto(f.url("/use-cache-test/inline-handler"));
    await waitForHydration(page);

    await expect(
      page.getByTestId("use-cache-inline-handler-page"),
    ).toBeVisible();
    const cachedTs1 = await page.getByTestId("inline-handler-ts").textContent();

    // Breadcrumb from inline "use cache" handler should appear
    const breadcrumbs = page.getByTestId("breadcrumbs");
    await expect(breadcrumbs).toBeVisible();
    await expect(breadcrumbs).toContainText("Inline Cached Handler");

    await page.goto(f.url("/"));
    await waitForHydration(page);

    // Second visit — cache hit, breadcrumbs replayed from cache
    await page.goto(f.url("/use-cache-test/inline-handler"));
    await waitForHydration(page);

    const cachedTs2 = await page.getByTestId("inline-handler-ts").textContent();
    expect(cachedTs2).toBe(cachedTs1);

    // Breadcrumb still appears (handle replay from cached entry)
    await expect(breadcrumbs).toBeVisible();
    await expect(breadcrumbs).toContainText("Inline Cached Handler");
  });

  test("inline use cache on parameterized path differentiates by params", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // Visit slug "alpha" — cache miss
    await page.goto(f.url("/use-cache-test/inline-params/alpha"));
    await waitForHydration(page);

    await expect(
      page.getByTestId("use-cache-inline-params-page"),
    ).toBeVisible();
    await expect(page.getByTestId("inline-params-slug")).toHaveText("alpha");
    const alphaTs = await page.getByTestId("inline-params-ts").textContent();
    const alphaRand = await page
      .getByTestId("inline-params-rand")
      .textContent();

    expect(alphaTs).toMatch(/^\d+$/);

    // Visit slug "beta" — different cache entry
    await page.goto(f.url("/use-cache-test/inline-params/beta"));
    await waitForHydration(page);

    await expect(page.getByTestId("inline-params-slug")).toHaveText("beta");
    const betaTs = await page.getByTestId("inline-params-ts").textContent();

    // Different slug must produce different cache entry
    expect(betaTs).not.toBe(alphaTs);

    // Revisit slug "alpha" — cache hit
    await page.goto(f.url("/use-cache-test/inline-params/alpha"));
    await waitForHydration(page);

    await expect(page.getByTestId("inline-params-slug")).toHaveText("alpha");
    const alphaTs2 = await page.getByTestId("inline-params-ts").textContent();
    const alphaRand2 = await page
      .getByTestId("inline-params-rand")
      .textContent();

    expect(alphaTs2).toBe(alphaTs);
    expect(alphaRand2).toBe(alphaRand);
  });

  test("inline use cache in layout: meta captured and replayed", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // First visit — cache miss, layout runs, meta set
    await page.goto(f.url("/use-cache-test/inline-layout"));
    await waitForHydration(page);

    await expect(
      page.getByTestId("use-cache-inline-layout-page"),
    ).toBeVisible();
    const layoutTs1 = await page.getByTestId("inline-layout-ts").textContent();

    // Meta title set by cached layout should be present
    await expect(page).toHaveTitle("Cached Layout Title");

    // Child route renders fresh each time (not cached)
    const childTs1 = await page
      .getByTestId("inline-layout-child-ts")
      .textContent();

    await page.goto(f.url("/"));
    await waitForHydration(page);

    // Second visit — layout from cache, meta replayed
    await page.goto(f.url("/use-cache-test/inline-layout"));
    await waitForHydration(page);

    const layoutTs2 = await page.getByTestId("inline-layout-ts").textContent();
    // Layout timestamp cached (same value)
    expect(layoutTs2).toBe(layoutTs1);

    // Meta title still correct (handle replay)
    await expect(page).toHaveTitle("Cached Layout Title");

    // Child route ran fresh (different timestamp)
    const childTs2 = await page
      .getByTestId("inline-layout-child-ts")
      .textContent();
    expect(Number(childTs2)).toBeGreaterThan(Number(childTs1));
  });

  test("cached function inside loader returns cached data", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // First visit — cache miss: getCachedLoaderData() runs
    await page.goto(f.url("/use-cache-test/with-loader"));
    await waitForHydration(page);

    await expect(page.getByTestId("use-cache-loader-page")).toBeVisible();
    const cachedTs1 = await page
      .getByTestId("use-cache-loader-ts")
      .textContent();
    const cachedRand1 = await page
      .getByTestId("use-cache-loader-rand")
      .textContent();
    const serverTs1 = await page
      .getByTestId("use-cache-loader-server-ts")
      .textContent();

    expect(cachedTs1).toMatch(/^\d+$/);
    expect(cachedRand1).toMatch(/^0\.\d+$/);

    // Navigate away
    await page.goto(f.url("/"));
    await waitForHydration(page);

    // Second visit — cache hit: inner cached function returns same data
    await page.goto(f.url("/use-cache-test/with-loader"));
    await waitForHydration(page);

    const cachedTs2 = await page
      .getByTestId("use-cache-loader-ts")
      .textContent();
    const cachedRand2 = await page
      .getByTestId("use-cache-loader-rand")
      .textContent();
    const serverTs2 = await page
      .getByTestId("use-cache-loader-server-ts")
      .textContent();

    // Cached function returned same data (cache hit)
    expect(cachedTs2).toBe(cachedTs1);
    expect(cachedRand2).toBe(cachedRand1);
    // Handler ran fresh (server time advanced)
    expect(Number(serverTs2)).toBeGreaterThan(Number(serverTs1));
  });

  test("intercept handler has distinct cache from path handler", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // Direct visit to path — cache miss for path handler
    await page.goto(f.url("/use-cache-test/intercept-target/1"));
    await waitForHydration(page);

    await expect(
      page.getByTestId("use-cache-intercept-path-page"),
    ).toBeVisible();
    const pathTs1 = await page.getByTestId("intercept-path-ts").textContent();
    const pathRand1 = await page
      .getByTestId("intercept-path-rand")
      .textContent();

    expect(pathTs1).toMatch(/^\d+$/);
    expect(pathRand1).toMatch(/^0\.\d+$/);

    // Navigate away and back — path handler cache hit
    await page.goto(f.url("/"));
    await waitForHydration(page);

    await page.goto(f.url("/use-cache-test/intercept-target/1"));
    await waitForHydration(page);

    const pathTs2 = await page.getByTestId("intercept-path-ts").textContent();
    const pathRand2 = await page
      .getByTestId("intercept-path-rand")
      .textContent();

    expect(pathTs2).toBe(pathTs1);
    expect(pathRand2).toBe(pathRand1);

    // Now navigate to intercept index and trigger intercept
    await page.goto(f.url("/use-cache-test/intercept-index"));
    await waitForHydration(page);

    await page.getByTestId("use-cache-intercept-link").click();
    await expect(page.getByTestId("use-cache-intercept-modal")).toBeVisible();

    const modalTs1 = await page.getByTestId("intercept-modal-ts").textContent();
    const modalRand1 = await page
      .getByTestId("intercept-modal-rand")
      .textContent();

    // Modal values must differ from path values (distinct cache entries)
    expect(modalTs1).not.toBe(pathTs1);

    // Navigate back to index and trigger intercept again — intercept cache hit
    await goBack(page);
    await expect(page.getByTestId("use-cache-intercept-index")).toBeVisible();

    await page.getByTestId("use-cache-intercept-link").click();
    await expect(page.getByTestId("use-cache-intercept-modal")).toBeVisible();

    const modalTs2 = await page.getByTestId("intercept-modal-ts").textContent();
    const modalRand2 = await page
      .getByTestId("intercept-modal-rand")
      .textContent();

    // Intercept handler cache hit — same values
    expect(modalTs2).toBe(modalTs1);
    expect(modalRand2).toBe(modalRand1);
  });
});

// ============================================================================
// Production mode tests
// ============================================================================

test.describe("use-cache handles (production)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "build",
  });

  test("a loader read inside the cached function and live shows its live crumb once on a HIT", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await expectUseCacheDepCrumbOnceAcrossHit(page, (p) => f.url(p));
  });

  test("a DSL loader passing its ctx caches per params and replays its crumb once", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await expectLoaderCtxCachedPerParams(page, (p) => f.url(p));
  });

  test("tainted ctx excluded from cache key and handles replayed", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/use-cache-test/with-handles"));
    await waitForHydration(page);

    await expect(page.getByTestId("use-cache-handles-page")).toBeVisible();
    const cachedTs1 = await page
      .getByTestId("use-cache-handles-ts")
      .textContent();
    const serverTs1 = await page
      .getByTestId("use-cache-handles-server-ts")
      .textContent();

    const breadcrumbs = page.getByTestId("breadcrumbs");
    await expect(breadcrumbs).toBeVisible();
    await expect(breadcrumbs).toContainText("Cached Page");

    await page.goto(f.url("/"));
    await waitForHydration(page);

    await page.goto(f.url("/use-cache-test/with-handles"));
    await waitForHydration(page);

    const cachedTs2 = await page
      .getByTestId("use-cache-handles-ts")
      .textContent();
    const serverTs2 = await page
      .getByTestId("use-cache-handles-server-ts")
      .textContent();

    expect(cachedTs2).toBe(cachedTs1);
    expect(Number(serverTs2)).toBeGreaterThan(Number(serverTs1));

    await expect(breadcrumbs).toBeVisible();
    await expect(breadcrumbs).toContainText("Cached Page");
  });

  test("cached function returning React node serializes through cache", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/use-cache-test/cached-node"));
    await waitForHydration(page);

    await expect(page.getByTestId("use-cache-node-page")).toBeVisible({
      timeout: 10000,
    });
    const cachedTs1 = await page.getByTestId("cached-node-ts").textContent();
    const cachedRand1 = await page
      .getByTestId("cached-node-rand")
      .textContent();
    const serverTs1 = await page
      .getByTestId("use-cache-node-server-ts")
      .textContent();

    await page.goto(f.url("/"));
    await waitForHydration(page);

    await page.goto(f.url("/use-cache-test/cached-node"));
    await waitForHydration(page);

    await expect(page.getByTestId("use-cache-node-page")).toBeVisible();
    const cachedTs2 = await page.getByTestId("cached-node-ts").textContent();
    const cachedRand2 = await page
      .getByTestId("cached-node-rand")
      .textContent();
    const serverTs2 = await page
      .getByTestId("use-cache-node-server-ts")
      .textContent();

    expect(cachedTs2).toBe(cachedTs1);
    expect(cachedRand2).toBe(cachedRand1);
    expect(Number(serverTs2)).toBeGreaterThan(Number(serverTs1));
  });

  test("inline use cache in path handler: breadcrumbs captured and replayed", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/use-cache-test/inline-handler"));
    await waitForHydration(page);

    await expect(
      page.getByTestId("use-cache-inline-handler-page"),
    ).toBeVisible();
    const cachedTs1 = await page.getByTestId("inline-handler-ts").textContent();

    const breadcrumbs = page.getByTestId("breadcrumbs");
    await expect(breadcrumbs).toBeVisible();
    await expect(breadcrumbs).toContainText("Inline Cached Handler");

    await page.goto(f.url("/"));
    await waitForHydration(page);

    await page.goto(f.url("/use-cache-test/inline-handler"));
    await waitForHydration(page);

    const cachedTs2 = await page.getByTestId("inline-handler-ts").textContent();
    expect(cachedTs2).toBe(cachedTs1);

    await expect(breadcrumbs).toBeVisible();
    await expect(breadcrumbs).toContainText("Inline Cached Handler");
  });

  test("inline use cache on parameterized path differentiates by params", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/use-cache-test/inline-params/alpha"));
    await waitForHydration(page);

    await expect(
      page.getByTestId("use-cache-inline-params-page"),
    ).toBeVisible();
    await expect(page.getByTestId("inline-params-slug")).toHaveText("alpha");
    const alphaTs = await page.getByTestId("inline-params-ts").textContent();
    const alphaRand = await page
      .getByTestId("inline-params-rand")
      .textContent();

    expect(alphaTs).toMatch(/^\d+$/);

    await page.goto(f.url("/use-cache-test/inline-params/beta"));
    await waitForHydration(page);

    await expect(page.getByTestId("inline-params-slug")).toHaveText("beta");
    const betaTs = await page.getByTestId("inline-params-ts").textContent();

    expect(betaTs).not.toBe(alphaTs);

    await page.goto(f.url("/use-cache-test/inline-params/alpha"));
    await waitForHydration(page);

    await expect(page.getByTestId("inline-params-slug")).toHaveText("alpha");
    const alphaTs2 = await page.getByTestId("inline-params-ts").textContent();
    const alphaRand2 = await page
      .getByTestId("inline-params-rand")
      .textContent();

    expect(alphaTs2).toBe(alphaTs);
    expect(alphaRand2).toBe(alphaRand);
  });

  test("inline use cache in layout: meta captured and replayed", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/use-cache-test/inline-layout"));
    await waitForHydration(page);

    await expect(
      page.getByTestId("use-cache-inline-layout-page"),
    ).toBeVisible();
    const layoutTs1 = await page.getByTestId("inline-layout-ts").textContent();

    await expect(page).toHaveTitle("Cached Layout Title");

    const childTs1 = await page
      .getByTestId("inline-layout-child-ts")
      .textContent();

    await page.goto(f.url("/"));
    await waitForHydration(page);

    await page.goto(f.url("/use-cache-test/inline-layout"));
    await waitForHydration(page);

    const layoutTs2 = await page.getByTestId("inline-layout-ts").textContent();
    expect(layoutTs2).toBe(layoutTs1);

    await expect(page).toHaveTitle("Cached Layout Title");

    const childTs2 = await page
      .getByTestId("inline-layout-child-ts")
      .textContent();
    expect(Number(childTs2)).toBeGreaterThan(Number(childTs1));
  });

  test("cached function inside loader returns cached data", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/use-cache-test/with-loader"));
    await waitForHydration(page);

    await expect(page.getByTestId("use-cache-loader-page")).toBeVisible();
    const cachedTs1 = await page
      .getByTestId("use-cache-loader-ts")
      .textContent();
    const cachedRand1 = await page
      .getByTestId("use-cache-loader-rand")
      .textContent();
    const serverTs1 = await page
      .getByTestId("use-cache-loader-server-ts")
      .textContent();

    expect(cachedTs1).toMatch(/^\d+$/);
    expect(cachedRand1).toMatch(/^0\.\d+$/);

    await page.goto(f.url("/"));
    await waitForHydration(page);

    await page.goto(f.url("/use-cache-test/with-loader"));
    await waitForHydration(page);

    const cachedTs2 = await page
      .getByTestId("use-cache-loader-ts")
      .textContent();
    const cachedRand2 = await page
      .getByTestId("use-cache-loader-rand")
      .textContent();
    const serverTs2 = await page
      .getByTestId("use-cache-loader-server-ts")
      .textContent();

    expect(cachedTs2).toBe(cachedTs1);
    expect(cachedRand2).toBe(cachedRand1);
    expect(Number(serverTs2)).toBeGreaterThan(Number(serverTs1));
  });

  test("intercept handler has distinct cache from path handler", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/use-cache-test/intercept-target/1"));
    await waitForHydration(page);

    await expect(
      page.getByTestId("use-cache-intercept-path-page"),
    ).toBeVisible();
    const pathTs1 = await page.getByTestId("intercept-path-ts").textContent();
    const pathRand1 = await page
      .getByTestId("intercept-path-rand")
      .textContent();

    expect(pathTs1).toMatch(/^\d+$/);
    expect(pathRand1).toMatch(/^0\.\d+$/);

    await page.goto(f.url("/"));
    await waitForHydration(page);

    await page.goto(f.url("/use-cache-test/intercept-target/1"));
    await waitForHydration(page);

    const pathTs2 = await page.getByTestId("intercept-path-ts").textContent();
    const pathRand2 = await page
      .getByTestId("intercept-path-rand")
      .textContent();

    expect(pathTs2).toBe(pathTs1);
    expect(pathRand2).toBe(pathRand1);

    await page.goto(f.url("/use-cache-test/intercept-index"));
    await waitForHydration(page);

    await page.getByTestId("use-cache-intercept-link").click();
    await expect(page.getByTestId("use-cache-intercept-modal")).toBeVisible();

    const modalTs1 = await page.getByTestId("intercept-modal-ts").textContent();
    const modalRand1 = await page
      .getByTestId("intercept-modal-rand")
      .textContent();

    expect(modalTs1).not.toBe(pathTs1);

    await goBack(page);
    await expect(page.getByTestId("use-cache-intercept-index")).toBeVisible();

    await page.getByTestId("use-cache-intercept-link").click();
    await expect(page.getByTestId("use-cache-intercept-modal")).toBeVisible();

    const modalTs2 = await page.getByTestId("intercept-modal-ts").textContent();
    const modalRand2 = await page
      .getByTestId("intercept-modal-rand")
      .textContent();

    expect(modalTs2).toBe(modalTs1);
    expect(modalRand2).toBe(modalRand1);
  });
});
