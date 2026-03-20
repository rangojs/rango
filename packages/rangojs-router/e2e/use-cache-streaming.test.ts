import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError } from "./helper";

/**
 * Tests for the "use cache" directive — streaming, interleave, and SWR.
 *
 * Validates streaming with loading boundaries, cached function output
 * with ReactNode slots, server action alongside cached data, and
 * stale-while-revalidate behavior.
 *
 * Strategy: cached functions embed Date.now() + Math.random() in their
 * return values. On cache hit the values are identical to the first call.
 * On cache miss they differ.
 */

// ============================================================================
// Dev mode tests
// ============================================================================

test.describe("use-cache streaming", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
    isolatedServer: true,
  });

  // First page.goto() on an isolated dev server triggers Vite dep
  // optimization → module re-evaluation → in-memory cache loss.
  // This warmup absorbs that cycle via a real browser render.
  test("warmup: trigger dep optimization before cache tests", async ({
    page,
  }) => {
    await page.goto(f.url("/"));
    await waitForHydration(page);
    // Navigate to the streaming page to warm its SSR modules
    await page.goto(f.url("/use-cache-test/streaming"));
    await waitForHydration(page);
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

    // Visit 2+: After TTL expiry, the next hit returns stale data and triggers
    // background revalidation. Subsequent visits return the fresh value.
    // With a shared server (production) the revalidation may already be done,
    // so we poll until we see a *different* value from visit 1.
    await expect(async () => {
      await page.goto(f.url("/use-cache-test/swr"));
      await waitForHydration(page);
      const ts = await page.getByTestId("use-cache-swr-ts").textContent();
      const rand = await page.getByTestId("use-cache-swr-rand").textContent();
      expect(ts).not.toBe(ts1);
      expect(rand).not.toBe(rand1);
    }).toPass({ timeout: 15000 });
  });
});

// ============================================================================
// Production mode tests
// ============================================================================

test.describe("use-cache streaming (production)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "build",
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

    // Visit 2+: After TTL expiry, the next hit returns stale data and triggers
    // background revalidation. Subsequent visits return the fresh value.
    // With a shared server (production) the revalidation may already be done,
    // so we poll until we see a *different* value from visit 1.
    await expect(async () => {
      await page.goto(f.url("/use-cache-test/swr"));
      await waitForHydration(page);
      const ts = await page.getByTestId("use-cache-swr-ts").textContent();
      const rand = await page.getByTestId("use-cache-swr-rand").textContent();
      expect(ts).not.toBe(ts1);
      expect(rand).not.toBe(rand1);
    }).toPass({ timeout: 15000 });
  });
});
