import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError, goBack } from "./helper";

/**
 * Tests for the "use cache" directive.
 *
 * Validates file-level and function-level "use cache" transforms,
 * named cache profiles, tainted ctx exclusion from cache keys,
 * handle capture/replay, streaming with loading boundaries,
 * and JSON endpoint caching.
 *
 * Strategy: cached functions embed Date.now() + Math.random() in their
 * return values. On cache hit the values are identical to the first call.
 * On cache miss they differ.
 */

// ============================================================================
// Dev mode tests
// ============================================================================

test.describe("use-cache basic", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
    isolatedServer: true,
  });

  test("file-level use cache returns cached data on second request", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // First visit — cache miss, runs getBasicTimestamp()
    await page.goto(f.url("/use-cache-test/basic"));
    await waitForHydration(page);

    await expect(page.getByTestId("use-cache-basic-page")).toBeVisible();
    const ts1 = await page.getByTestId("use-cache-basic-ts").textContent();
    const rand1 = await page.getByTestId("use-cache-basic-rand").textContent();

    expect(ts1).toMatch(/^\d+$/);
    expect(rand1).toMatch(/^0\.\d+$/);

    // Navigate away
    await page.goto(f.url("/"));
    await waitForHydration(page);

    // Second visit — should be a cache hit (same ts and rand)
    await page.goto(f.url("/use-cache-test/basic"));
    await waitForHydration(page);

    const ts2 = await page.getByTestId("use-cache-basic-ts").textContent();
    const rand2 = await page.getByTestId("use-cache-basic-rand").textContent();

    expect(ts2).toBe(ts1);
    expect(rand2).toBe(rand1);
  });

  test("different args produce different cache entries", async ({ page }) => {
    using _ = expectNoPageError(page);

    // Visit category "fruits"
    await page.goto(f.url("/use-cache-test/with-args/fruits"));
    await waitForHydration(page);

    await expect(page.getByTestId("use-cache-args-category")).toHaveText(
      "fruits",
    );
    const fruitTs = await page.getByTestId("use-cache-args-ts").textContent();
    const fruitRand = await page
      .getByTestId("use-cache-args-rand")
      .textContent();

    // Visit category "veggies" — different cache key
    await page.goto(f.url("/use-cache-test/with-args/veggies"));
    await waitForHydration(page);

    await expect(page.getByTestId("use-cache-args-category")).toHaveText(
      "veggies",
    );
    const veggieTs = await page.getByTestId("use-cache-args-ts").textContent();

    // Different category should have different timestamp (cache miss)
    expect(veggieTs).not.toBe(fruitTs);

    // Revisit "fruits" — should be cache hit
    await page.goto(f.url("/use-cache-test/with-args/fruits"));
    await waitForHydration(page);

    const fruitTs2 = await page.getByTestId("use-cache-args-ts").textContent();
    const fruitRand2 = await page
      .getByTestId("use-cache-args-rand")
      .textContent();

    expect(fruitTs2).toBe(fruitTs);
    expect(fruitRand2).toBe(fruitRand);
  });

  test("named profile use cache: short works", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/use-cache-test/named-profile"));
    await waitForHydration(page);

    await expect(page.getByTestId("use-cache-profile-page")).toBeVisible();
    const ts1 = await page.getByTestId("use-cache-profile-ts").textContent();
    expect(ts1).toMatch(/^\d+$/);

    // Navigate away and back — should hit cache
    await page.goto(f.url("/"));
    await waitForHydration(page);

    await page.goto(f.url("/use-cache-test/named-profile"));
    await waitForHydration(page);

    const ts2 = await page.getByTestId("use-cache-profile-ts").textContent();
    expect(ts2).toBe(ts1);
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

  test("streaming: cached timestamp stays consistent while server time advances", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // First visit — cache miss, 500ms delay
    await page.goto(f.url("/use-cache-test/streaming"));
    await waitForHydration(page);

    await expect(page.getByTestId("use-cache-streaming-page")).toBeVisible({
      timeout: 10000,
    });
    const cachedTs1 = await page
      .getByTestId("use-cache-streaming-ts")
      .textContent();
    const serverTs1 = await page
      .getByTestId("use-cache-streaming-server-ts")
      .textContent();
    expect(cachedTs1).toMatch(/^\d+$/);
    expect(serverTs1).toMatch(/^\d+$/);

    // Navigate away
    await page.goto(f.url("/"));
    await waitForHydration(page);

    // Second visit — cache hit: cached ts unchanged, server ts is fresh
    await page.goto(f.url("/use-cache-test/streaming"));
    await waitForHydration(page);

    await expect(page.getByTestId("use-cache-streaming-page")).toBeVisible();
    const cachedTs2 = await page
      .getByTestId("use-cache-streaming-ts")
      .textContent();
    const serverTs2 = await page
      .getByTestId("use-cache-streaming-server-ts")
      .textContent();

    // Cached value is identical (resolved from cache, not re-executed)
    expect(cachedTs2).toBe(cachedTs1);
    // Server timestamp is fresh (handler ran again, only the cached fn was skipped)
    expect(Number(serverTs2)).toBeGreaterThan(Number(serverTs1));
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

  test("plain data JSON endpoint returns cached data", async ({ request }) => {
    // First request — cache miss
    const res1 = await request.get(f.url("/use-cache-test/plain-data"));
    expect(res1.status()).toBe(200);
    const body1 = await res1.json();
    expect(typeof body1.data.ts).toBe("number");
    expect(typeof body1.data.rand).toBe("number");

    // Small delay for async cache write
    await new Promise((r) => setTimeout(r, 200));

    // Second request — cache hit, same data
    const res2 = await request.get(f.url("/use-cache-test/plain-data"));
    expect(res2.status()).toBe(200);
    const body2 = await res2.json();

    expect(body2.data.ts).toBe(body1.data.ts);
    expect(body2.data.rand).toBe(body1.data.rand);
  });

  test("use cache functions are branded at runtime", async ({ request }) => {
    const res = await request.get(f.url("/use-cache-test/brand-check"));
    expect(res.status()).toBe(200);
    const body = await res.json();

    // File-level "use cache" function should be branded
    expect(body.data.cachedFnBranded).toBe(true);
    // Plain function should not be branded
    expect(body.data.plainFnBranded).toBe(false);
  });

  test("cookies() throws inside a 'use cache' function", async ({
    request,
  }) => {
    const res = await request.get(f.url("/use-cache-test/guard-cookies"));
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.data.threw).toBe(true);
    expect(body.data.message).toMatch(/cookies\(\) cannot be called inside/i);
    expect(body.data.message).toMatch(/cache key/i);
  });

  test("headers() throws inside a 'use cache' function", async ({
    request,
  }) => {
    const res = await request.get(f.url("/use-cache-test/guard-headers"));
    expect(res.status()).toBe(200);
    const body = await res.json();

    expect(body.data.threw).toBe(true);
    expect(body.data.message).toMatch(/headers\(\) cannot be called inside/i);
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

  test("interleave: cached function with ReactNode slots returns frozen output on cache hit", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // First visit — CachedWithSlots receives dynamic ReactNode slots.
    // The entire cached function output (including rendered slot content)
    // is serialized and stored. On cache hit, the stored output is returned
    // as-is — slot content is NOT interleaved separately.
    await page.goto(f.url("/use-cache-test/interleave-slots"));
    await waitForHydration(page);

    await expect(page.getByTestId("interleave-slots-page")).toBeVisible();

    const cachedTs1 = await page.getByTestId("cached-slots-ts").textContent();
    const cachedRand1 = await page
      .getByTestId("cached-slots-rand")
      .textContent();
    const headerContent1 = await page
      .getByTestId("interleave-slots-header-content")
      .textContent();
    const childrenContent1 = await page
      .getByTestId("interleave-slots-children-content")
      .textContent();
    const serverTs1 = await page
      .getByTestId("interleave-slots-server-ts")
      .textContent();

    expect(cachedTs1).toMatch(/^\d+$/);
    expect(cachedRand1).toMatch(/^0\.\d+$/);
    expect(headerContent1).toMatch(/^.+$/);

    // Header and children should show the same dynamicTs
    expect(headerContent1).toBe(childrenContent1);

    // Navigate away
    await page.goto(f.url("/"));
    await waitForHydration(page);

    // Second visit — cached function returns frozen result (cache hit).
    // Both the function's own data and the rendered slot content are frozen.
    await page.goto(f.url("/use-cache-test/interleave-slots"));
    await waitForHydration(page);

    const cachedTs2 = await page.getByTestId("cached-slots-ts").textContent();
    const cachedRand2 = await page
      .getByTestId("cached-slots-rand")
      .textContent();
    const headerContent2 = await page
      .getByTestId("interleave-slots-header-content")
      .textContent();
    const childrenContent2 = await page
      .getByTestId("interleave-slots-children-content")
      .textContent();
    const serverTs2 = await page
      .getByTestId("interleave-slots-server-ts")
      .textContent();

    // Cached function data is frozen (cache hit)
    expect(cachedTs2).toBe(cachedTs1);
    expect(cachedRand2).toBe(cachedRand1);

    // Slot content is also frozen (part of cached output)
    expect(headerContent2).toBe(headerContent1);
    expect(childrenContent2).toBe(childrenContent1);

    // Handler's own timestamp is fresh (handler runs on every request,
    // only the CachedWithSlots call returns cached output)
    expect(Number(serverTs2)).toBeGreaterThan(Number(serverTs1));
  });

  test("interleave: server action works alongside cached data", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // Visit page — getCachedActionData() runs (cache miss), client component renders
    await page.goto(f.url("/use-cache-test/interleave-action"));
    await waitForHydration(page);

    await expect(page.getByTestId("interleave-action-page")).toBeVisible();

    const cachedTs1 = await page.getByTestId("cached-action-ts").textContent();
    const cachedRand1 = await page
      .getByTestId("cached-action-rand")
      .textContent();
    const serverTs1 = await page
      .getByTestId("interleave-action-server-ts")
      .textContent();

    expect(cachedTs1).toMatch(/^\d+$/);
    expect(cachedRand1).toMatch(/^0\.\d+$/);

    // Client component with server action renders alongside cached data
    await expect(page.getByTestId("interleave-action-btn")).toBeVisible();
    await expect(page.getByTestId("interleave-action-btn")).toBeEnabled();

    // Navigate away
    await page.goto(f.url("/"));
    await waitForHydration(page);

    // Second visit — cached data should be stable (cache hit)
    await page.goto(f.url("/use-cache-test/interleave-action"));
    await waitForHydration(page);

    const cachedTs2 = await page.getByTestId("cached-action-ts").textContent();
    const cachedRand2 = await page
      .getByTestId("cached-action-rand")
      .textContent();
    const serverTs2 = await page
      .getByTestId("interleave-action-server-ts")
      .textContent();

    // Cached function data is frozen (cache hit)
    expect(cachedTs2).toBe(cachedTs1);
    expect(cachedRand2).toBe(cachedRand1);
    // Handler ran fresh (server time advanced)
    expect(Number(serverTs2)).toBeGreaterThan(Number(serverTs1));

    // Client component still renders correctly on cache hit
    await expect(page.getByTestId("interleave-action-btn")).toBeVisible();
    await expect(page.getByTestId("interleave-action-btn")).toBeEnabled();
  });

  test("path.json with use cache: params differentiate entries", async ({
    request,
  }) => {
    // First request — cache miss for id=1
    const res1 = await request.get(f.url("/use-cache-test/json-cached/1"));
    expect(res1.status()).toBe(200);
    const body1 = await res1.json();
    expect(body1.data.id).toBe("1");

    // Small delay for async cache write
    await new Promise((r) => setTimeout(r, 200));

    // Second request with same id — cache hit
    const res2 = await request.get(f.url("/use-cache-test/json-cached/1"));
    expect(res2.status()).toBe(200);
    const body2 = await res2.json();
    expect(body2.data.ts).toBe(body1.data.ts);
    expect(body2.data.rand).toBe(body1.data.rand);

    // Different id — cache miss, different entry
    const res3 = await request.get(f.url("/use-cache-test/json-cached/2"));
    expect(res3.status()).toBe(200);
    const body3 = await res3.json();
    expect(body3.data.id).toBe("2");
    expect(body3.data.ts).not.toBe(body1.data.ts);
  });

  test("SWR: stale value returned, background revalidation produces fresh value", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // Visit 1: cache miss — runs function, caches result
    await page.goto(f.url("/use-cache-test/swr"));
    await waitForHydration(page);

    await expect(page.getByTestId("use-cache-swr-page")).toBeVisible();
    const ts1 = await page.getByTestId("use-cache-swr-ts").textContent();
    const rand1 = await page.getByTestId("use-cache-swr-rand").textContent();

    // Breadcrumbs captured on miss
    const breadcrumbs = page.getByTestId("breadcrumbs");
    await expect(breadcrumbs).toBeVisible();
    await expect(breadcrumbs).toContainText("SWR Cached Page");

    expect(ts1).toMatch(/^\d+$/);
    expect(rand1).toMatch(/^0\.\d+$/);

    // Wait for TTL to expire (profile: ttl=2s, swr=60s)
    await page.waitForTimeout(3000);

    // Visit 2: stale hit — returns same cached value, triggers background revalidation
    await page.goto(f.url("/use-cache-test/swr"));
    await waitForHydration(page);

    const ts2 = await page.getByTestId("use-cache-swr-ts").textContent();
    const rand2 = await page.getByTestId("use-cache-swr-rand").textContent();

    // Stale value is identical to visit 1
    expect(ts2).toBe(ts1);
    expect(rand2).toBe(rand1);

    // Breadcrumbs still present (replayed from stale cache entry)
    await expect(breadcrumbs).toBeVisible();
    await expect(breadcrumbs).toContainText("SWR Cached Page");

    // Wait for background revalidation to complete
    await page.waitForTimeout(2000);

    // Visit 3: fresh value from background revalidation
    await page.goto(f.url("/use-cache-test/swr"));
    await waitForHydration(page);

    const ts3 = await page.getByTestId("use-cache-swr-ts").textContent();
    const rand3 = await page.getByTestId("use-cache-swr-rand").textContent();

    // Value should differ — background revalidation wrote a new entry
    expect(ts3).not.toBe(ts1);
    expect(rand3).not.toBe(rand1);

    // Breadcrumbs still present (captured during background revalidation)
    await expect(breadcrumbs).toBeVisible();
    await expect(breadcrumbs).toContainText("SWR Cached Page");
  });
});

// ============================================================================
// Production mode tests
// ============================================================================

test.describe("use-cache (production)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "build",
  });

  test("file-level use cache returns cached data on second request", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/use-cache-test/basic"));
    await waitForHydration(page);

    await expect(page.getByTestId("use-cache-basic-page")).toBeVisible();
    const ts1 = await page.getByTestId("use-cache-basic-ts").textContent();
    const rand1 = await page.getByTestId("use-cache-basic-rand").textContent();

    expect(ts1).toMatch(/^\d+$/);
    expect(rand1).toMatch(/^0\.\d+$/);

    await page.goto(f.url("/"));
    await waitForHydration(page);

    await page.goto(f.url("/use-cache-test/basic"));
    await waitForHydration(page);

    const ts2 = await page.getByTestId("use-cache-basic-ts").textContent();
    const rand2 = await page.getByTestId("use-cache-basic-rand").textContent();

    expect(ts2).toBe(ts1);
    expect(rand2).toBe(rand1);
  });

  test("different args produce different cache entries", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/use-cache-test/with-args/fruits"));
    await waitForHydration(page);

    await expect(page.getByTestId("use-cache-args-category")).toHaveText(
      "fruits",
    );
    const fruitTs = await page.getByTestId("use-cache-args-ts").textContent();
    const fruitRand = await page
      .getByTestId("use-cache-args-rand")
      .textContent();

    await page.goto(f.url("/use-cache-test/with-args/veggies"));
    await waitForHydration(page);

    await expect(page.getByTestId("use-cache-args-category")).toHaveText(
      "veggies",
    );
    const veggieTs = await page.getByTestId("use-cache-args-ts").textContent();
    expect(veggieTs).not.toBe(fruitTs);

    await page.goto(f.url("/use-cache-test/with-args/fruits"));
    await waitForHydration(page);

    const fruitTs2 = await page.getByTestId("use-cache-args-ts").textContent();
    const fruitRand2 = await page
      .getByTestId("use-cache-args-rand")
      .textContent();

    expect(fruitTs2).toBe(fruitTs);
    expect(fruitRand2).toBe(fruitRand);
  });

  test("named profile use cache: short works", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/use-cache-test/named-profile"));
    await waitForHydration(page);

    await expect(page.getByTestId("use-cache-profile-page")).toBeVisible();
    const ts1 = await page.getByTestId("use-cache-profile-ts").textContent();

    await page.goto(f.url("/"));
    await waitForHydration(page);

    await page.goto(f.url("/use-cache-test/named-profile"));
    await waitForHydration(page);

    const ts2 = await page.getByTestId("use-cache-profile-ts").textContent();
    expect(ts2).toBe(ts1);
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

  test("streaming: cached timestamp stays consistent while server time advances", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/use-cache-test/streaming"));
    await waitForHydration(page);

    await expect(page.getByTestId("use-cache-streaming-page")).toBeVisible({
      timeout: 10000,
    });
    const cachedTs1 = await page
      .getByTestId("use-cache-streaming-ts")
      .textContent();
    const serverTs1 = await page
      .getByTestId("use-cache-streaming-server-ts")
      .textContent();

    await page.goto(f.url("/"));
    await waitForHydration(page);

    await page.goto(f.url("/use-cache-test/streaming"));
    await waitForHydration(page);

    await expect(page.getByTestId("use-cache-streaming-page")).toBeVisible();
    const cachedTs2 = await page
      .getByTestId("use-cache-streaming-ts")
      .textContent();
    const serverTs2 = await page
      .getByTestId("use-cache-streaming-server-ts")
      .textContent();

    expect(cachedTs2).toBe(cachedTs1);
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

  test("plain data JSON endpoint returns cached data", async ({ request }) => {
    const res1 = await request.get(f.url("/use-cache-test/plain-data"));
    expect(res1.status()).toBe(200);
    const body1 = await res1.json();
    expect(typeof body1.data.ts).toBe("number");
    expect(typeof body1.data.rand).toBe("number");

    await new Promise((r) => setTimeout(r, 200));

    const res2 = await request.get(f.url("/use-cache-test/plain-data"));
    expect(res2.status()).toBe(200);
    const body2 = await res2.json();

    expect(body2.data.ts).toBe(body1.data.ts);
    expect(body2.data.rand).toBe(body1.data.rand);
  });

  test("use cache functions are branded at runtime", async ({ request }) => {
    const res = await request.get(f.url("/use-cache-test/brand-check"));
    expect(res.status()).toBe(200);
    const body = await res.json();

    expect(body.data.cachedFnBranded).toBe(true);
    expect(body.data.plainFnBranded).toBe(false);
  });

  test("cookies() throws inside a 'use cache' function", async ({
    request,
  }) => {
    const res = await request.get(f.url("/use-cache-test/guard-cookies"));
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.data.threw).toBe(true);
    expect(body.data.message).toMatch(/cookies\(\) cannot be called inside/i);
    expect(body.data.message).toMatch(/cache key/i);
  });

  test("headers() throws inside a 'use cache' function", async ({
    request,
  }) => {
    const res = await request.get(f.url("/use-cache-test/guard-headers"));
    expect(res.status()).toBe(200);
    const body = await res.json();

    expect(body.data.threw).toBe(true);
    expect(body.data.message).toMatch(/headers\(\) cannot be called inside/i);
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

  test("interleave: cached function with ReactNode slots returns frozen output on cache hit", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/use-cache-test/interleave-slots"));
    await waitForHydration(page);

    await expect(page.getByTestId("interleave-slots-page")).toBeVisible();

    const cachedTs1 = await page.getByTestId("cached-slots-ts").textContent();
    const cachedRand1 = await page
      .getByTestId("cached-slots-rand")
      .textContent();
    const headerContent1 = await page
      .getByTestId("interleave-slots-header-content")
      .textContent();
    const childrenContent1 = await page
      .getByTestId("interleave-slots-children-content")
      .textContent();
    const serverTs1 = await page
      .getByTestId("interleave-slots-server-ts")
      .textContent();

    expect(cachedTs1).toMatch(/^\d+$/);
    expect(cachedRand1).toMatch(/^0\.\d+$/);
    expect(headerContent1).toMatch(/^.+$/);

    expect(headerContent1).toBe(childrenContent1);

    await page.goto(f.url("/"));
    await waitForHydration(page);

    await page.goto(f.url("/use-cache-test/interleave-slots"));
    await waitForHydration(page);

    const cachedTs2 = await page.getByTestId("cached-slots-ts").textContent();
    const cachedRand2 = await page
      .getByTestId("cached-slots-rand")
      .textContent();
    const headerContent2 = await page
      .getByTestId("interleave-slots-header-content")
      .textContent();
    const childrenContent2 = await page
      .getByTestId("interleave-slots-children-content")
      .textContent();
    const serverTs2 = await page
      .getByTestId("interleave-slots-server-ts")
      .textContent();

    // Cached function data is frozen (cache hit)
    expect(cachedTs2).toBe(cachedTs1);
    expect(cachedRand2).toBe(cachedRand1);

    // Slot content is also frozen (part of cached output)
    expect(headerContent2).toBe(headerContent1);
    expect(childrenContent2).toBe(childrenContent1);

    // Handler's own timestamp is fresh (handler runs on every request)
    expect(Number(serverTs2)).toBeGreaterThan(Number(serverTs1));
  });

  test("interleave: server action works alongside cached data", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // Visit page — getCachedActionData() runs (cache miss), client component renders
    await page.goto(f.url("/use-cache-test/interleave-action"));
    await waitForHydration(page);

    await expect(page.getByTestId("interleave-action-page")).toBeVisible();

    const cachedTs1 = await page.getByTestId("cached-action-ts").textContent();
    const cachedRand1 = await page
      .getByTestId("cached-action-rand")
      .textContent();
    const serverTs1 = await page
      .getByTestId("interleave-action-server-ts")
      .textContent();

    expect(cachedTs1).toMatch(/^\d+$/);
    expect(cachedRand1).toMatch(/^0\.\d+$/);

    // Client component with server action renders alongside cached data
    await expect(page.getByTestId("interleave-action-btn")).toBeVisible();
    await expect(page.getByTestId("interleave-action-btn")).toBeEnabled();

    // Navigate away
    await page.goto(f.url("/"));
    await waitForHydration(page);

    // Second visit — cached data should be stable (cache hit)
    await page.goto(f.url("/use-cache-test/interleave-action"));
    await waitForHydration(page);

    const cachedTs2 = await page.getByTestId("cached-action-ts").textContent();
    const cachedRand2 = await page
      .getByTestId("cached-action-rand")
      .textContent();
    const serverTs2 = await page
      .getByTestId("interleave-action-server-ts")
      .textContent();

    // Cached function data is frozen (cache hit)
    expect(cachedTs2).toBe(cachedTs1);
    expect(cachedRand2).toBe(cachedRand1);
    // Handler ran fresh (server time advanced)
    expect(Number(serverTs2)).toBeGreaterThan(Number(serverTs1));

    // Client component still renders correctly on cache hit
    await expect(page.getByTestId("interleave-action-btn")).toBeVisible();
    await expect(page.getByTestId("interleave-action-btn")).toBeEnabled();
  });

  test("path.json with use cache: params differentiate entries", async ({
    request,
  }) => {
    const res1 = await request.get(f.url("/use-cache-test/json-cached/1"));
    expect(res1.status()).toBe(200);
    const body1 = await res1.json();
    expect(body1.data.id).toBe("1");

    await new Promise((r) => setTimeout(r, 200));

    const res2 = await request.get(f.url("/use-cache-test/json-cached/1"));
    expect(res2.status()).toBe(200);
    const body2 = await res2.json();
    expect(body2.data.ts).toBe(body1.data.ts);
    expect(body2.data.rand).toBe(body1.data.rand);

    const res3 = await request.get(f.url("/use-cache-test/json-cached/2"));
    expect(res3.status()).toBe(200);
    const body3 = await res3.json();
    expect(body3.data.id).toBe("2");
    expect(body3.data.ts).not.toBe(body1.data.ts);
  });

  test("SWR: stale value returned, background revalidation produces fresh value", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // Visit 1: cache miss — runs function, caches result
    await page.goto(f.url("/use-cache-test/swr"));
    await waitForHydration(page);

    await expect(page.getByTestId("use-cache-swr-page")).toBeVisible();
    const ts1 = await page.getByTestId("use-cache-swr-ts").textContent();
    const rand1 = await page.getByTestId("use-cache-swr-rand").textContent();

    // Breadcrumbs captured on miss
    const breadcrumbs = page.getByTestId("breadcrumbs");
    await expect(breadcrumbs).toBeVisible();
    await expect(breadcrumbs).toContainText("SWR Cached Page");

    expect(ts1).toMatch(/^\d+$/);
    expect(rand1).toMatch(/^0\.\d+$/);

    // Wait for TTL to expire (profile: ttl=2s, swr=60s)
    await page.waitForTimeout(3000);

    // Visit 2: stale hit — returns same cached value, triggers background revalidation
    await page.goto(f.url("/use-cache-test/swr"));
    await waitForHydration(page);

    const ts2 = await page.getByTestId("use-cache-swr-ts").textContent();
    const rand2 = await page.getByTestId("use-cache-swr-rand").textContent();

    // Stale value is identical to visit 1
    expect(ts2).toBe(ts1);
    expect(rand2).toBe(rand1);

    // Breadcrumbs still present (replayed from stale cache entry)
    await expect(breadcrumbs).toBeVisible();
    await expect(breadcrumbs).toContainText("SWR Cached Page");

    // Wait for background revalidation to complete
    await page.waitForTimeout(2000);

    // Visit 3: fresh value from background revalidation
    await page.goto(f.url("/use-cache-test/swr"));
    await waitForHydration(page);

    const ts3 = await page.getByTestId("use-cache-swr-ts").textContent();
    const rand3 = await page.getByTestId("use-cache-swr-rand").textContent();

    // Value should differ — background revalidation wrote a new entry
    expect(ts3).not.toBe(ts1);
    expect(rand3).not.toBe(rand1);

    // Breadcrumbs still present (captured during background revalidation)
    await expect(breadcrumbs).toBeVisible();
    await expect(breadcrumbs).toContainText("SWR Cached Page");
  });
});
