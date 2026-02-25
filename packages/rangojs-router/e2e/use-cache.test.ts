import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError } from "./helper";

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

    expect(ts1).toBeTruthy();
    expect(rand1).toBeTruthy();

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
    const fruitTs = await page
      .getByTestId("use-cache-args-ts")
      .textContent();
    const fruitRand = await page
      .getByTestId("use-cache-args-rand")
      .textContent();

    // Visit category "veggies" — different cache key
    await page.goto(f.url("/use-cache-test/with-args/veggies"));
    await waitForHydration(page);

    await expect(page.getByTestId("use-cache-args-category")).toHaveText(
      "veggies",
    );
    const veggieTs = await page
      .getByTestId("use-cache-args-ts")
      .textContent();

    // Different category should have different timestamp (cache miss)
    expect(veggieTs).not.toBe(fruitTs);

    // Revisit "fruits" — should be cache hit
    await page.goto(f.url("/use-cache-test/with-args/fruits"));
    await waitForHydration(page);

    const fruitTs2 = await page
      .getByTestId("use-cache-args-ts")
      .textContent();
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
    expect(ts1).toBeTruthy();

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
    expect(cachedTs1).toBeTruthy();
    expect(serverTs1).toBeTruthy();

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
    const cachedTs1 = await page
      .getByTestId("cached-node-ts")
      .textContent();
    const cachedRand1 = await page
      .getByTestId("cached-node-rand")
      .textContent();
    const serverTs1 = await page
      .getByTestId("use-cache-node-server-ts")
      .textContent();

    expect(cachedTs1).toBeTruthy();
    expect(cachedRand1).toBeTruthy();

    // Navigate away
    await page.goto(f.url("/"));
    await waitForHydration(page);

    // Second visit — cache hit, JSX deserialized from cache
    await page.goto(f.url("/use-cache-test/cached-node"));
    await waitForHydration(page);

    await expect(page.getByTestId("use-cache-node-page")).toBeVisible();
    const cachedTs2 = await page
      .getByTestId("cached-node-ts")
      .textContent();
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
    const cachedTs1 = await page
      .getByTestId("inline-handler-ts")
      .textContent();

    // Breadcrumb from inline "use cache" handler should appear
    const breadcrumbs = page.getByTestId("breadcrumbs");
    await expect(breadcrumbs).toBeVisible();
    await expect(breadcrumbs).toContainText("Inline Cached Handler");

    await page.goto(f.url("/"));
    await waitForHydration(page);

    // Second visit — cache hit, breadcrumbs replayed from cache
    await page.goto(f.url("/use-cache-test/inline-handler"));
    await waitForHydration(page);

    const cachedTs2 = await page
      .getByTestId("inline-handler-ts")
      .textContent();
    expect(cachedTs2).toBe(cachedTs1);

    // Breadcrumb still appears (handle replay from cached entry)
    await expect(breadcrumbs).toBeVisible();
    await expect(breadcrumbs).toContainText("Inline Cached Handler");
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
    const layoutTs1 = await page
      .getByTestId("inline-layout-ts")
      .textContent();

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

    const layoutTs2 = await page
      .getByTestId("inline-layout-ts")
      .textContent();
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

    expect(ts1).toBeTruthy();
    expect(rand1).toBeTruthy();

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
    const fruitTs = await page
      .getByTestId("use-cache-args-ts")
      .textContent();
    const fruitRand = await page
      .getByTestId("use-cache-args-rand")
      .textContent();

    await page.goto(f.url("/use-cache-test/with-args/veggies"));
    await waitForHydration(page);

    await expect(page.getByTestId("use-cache-args-category")).toHaveText(
      "veggies",
    );
    const veggieTs = await page
      .getByTestId("use-cache-args-ts")
      .textContent();
    expect(veggieTs).not.toBe(fruitTs);

    await page.goto(f.url("/use-cache-test/with-args/fruits"));
    await waitForHydration(page);

    const fruitTs2 = await page
      .getByTestId("use-cache-args-ts")
      .textContent();
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
    const cachedTs1 = await page
      .getByTestId("cached-node-ts")
      .textContent();
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
    const cachedTs2 = await page
      .getByTestId("cached-node-ts")
      .textContent();
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
    const cachedTs1 = await page
      .getByTestId("inline-handler-ts")
      .textContent();

    const breadcrumbs = page.getByTestId("breadcrumbs");
    await expect(breadcrumbs).toBeVisible();
    await expect(breadcrumbs).toContainText("Inline Cached Handler");

    await page.goto(f.url("/"));
    await waitForHydration(page);

    await page.goto(f.url("/use-cache-test/inline-handler"));
    await waitForHydration(page);

    const cachedTs2 = await page
      .getByTestId("inline-handler-ts")
      .textContent();
    expect(cachedTs2).toBe(cachedTs1);

    await expect(breadcrumbs).toBeVisible();
    await expect(breadcrumbs).toContainText("Inline Cached Handler");
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
    const layoutTs1 = await page
      .getByTestId("inline-layout-ts")
      .textContent();

    await expect(page).toHaveTitle("Cached Layout Title");

    const childTs1 = await page
      .getByTestId("inline-layout-child-ts")
      .textContent();

    await page.goto(f.url("/"));
    await waitForHydration(page);

    await page.goto(f.url("/use-cache-test/inline-layout"));
    await waitForHydration(page);

    const layoutTs2 = await page
      .getByTestId("inline-layout-ts")
      .textContent();
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
});
