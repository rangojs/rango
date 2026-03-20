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
  test.describe.configure({ mode: "serial" });

  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
    isolatedServer: true,
  });

  async function waitForStreamingPageToSettle(
    page: import("@playwright/test").Page,
  ) {
    await waitForHydration(page);
    await expect(page.getByTestId("use-cache-streaming-page")).toBeVisible({
      timeout: 10000,
    });
    await expect(page.getByTestId("use-cache-streaming-ts")).toHaveText(
      /^\d+$/,
      { timeout: 10000 },
    );
    return (
      (await page.getByTestId("use-cache-streaming-ts").textContent()) ?? ""
    );
  }

  async function navigateHome(page: import("@playwright/test").Page) {
    await page.goto(f.url("/"));
    await waitForHydration(page);
  }

  async function readStreamingSnapshot(
    page: import("@playwright/test").Page,
  ): Promise<{ cachedTs: string; serverTs: string }> {
    await page.goto(f.url("/use-cache-test/streaming"));
    await waitForStreamingPageToSettle(page);

    return {
      cachedTs:
        (await page.getByTestId("use-cache-streaming-ts").textContent()) ?? "",
      serverTs:
        (await page
          .getByTestId("use-cache-streaming-server-ts")
          .textContent()) ?? "",
    };
  }

  async function readInterleaveSnapshot(
    page: import("@playwright/test").Page,
  ): Promise<{
    cachedTs: string;
    cachedRand: string;
    headerContent: string;
    childrenContent: string;
    serverTs: string;
  }> {
    await page.goto(f.url("/use-cache-test/interleave-slots"));
    await waitForHydration(page);
    await expect(page.getByTestId("interleave-slots-page")).toBeVisible();

    return {
      cachedTs: (await page.getByTestId("cached-slots-ts").textContent()) ?? "",
      cachedRand:
        (await page.getByTestId("cached-slots-rand").textContent()) ?? "",
      headerContent:
        (await page
          .getByTestId("interleave-slots-header-content")
          .textContent()) ?? "",
      childrenContent:
        (await page
          .getByTestId("interleave-slots-children-content")
          .textContent()) ?? "",
      serverTs:
        (await page.getByTestId("interleave-slots-server-ts").textContent()) ??
        "",
    };
  }

  // First page.goto() on an isolated dev server triggers Vite dep
  // optimization → module re-evaluation → in-memory cache loss.
  // This warmup absorbs that cycle via a real browser render and then
  // revisits the streaming route until we see a stable cached timestamp.
  test("warmup: trigger dep optimization before cache tests", async ({
    page,
  }) => {
    await page.goto(f.url("/"));
    await waitForHydration(page);

    let previousCachedTs: string | null = null;
    let stableCachedTs: string | null = null;

    for (let attempt = 0; attempt < 4; attempt++) {
      await page.goto(f.url("/use-cache-test/streaming"));
      const cachedTs = await waitForStreamingPageToSettle(page);

      if (cachedTs === previousCachedTs) {
        stableCachedTs = cachedTs;
        break;
      }

      previousCachedTs = cachedTs;
      await page.goto(f.url("/"));
      await waitForHydration(page);
    }

    expect(stableCachedTs).toMatch(/^\d+$/);
  });

  test("streaming: cached timestamp stays consistent while server time advances", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // The first measured visit can still absorb one last dev-server settle
    // cycle, so allow a single re-baseline before enforcing cache stability.
    let baseline = await readStreamingSnapshot(page);
    let next: { cachedTs: string; serverTs: string };

    await navigateHome(page);
    next = await readStreamingSnapshot(page);

    if (next.cachedTs !== baseline.cachedTs) {
      baseline = next;
      await navigateHome(page);
      next = await readStreamingSnapshot(page);
    }

    const cachedTs1 = baseline.cachedTs;
    const serverTs1 = baseline.serverTs;
    expect(cachedTs1).toMatch(/^\d+$/);
    expect(serverTs1).toMatch(/^\d+$/);

    const cachedTs2 = next.cachedTs;
    const serverTs2 = next.serverTs;

    // Cached value is identical (resolved from cache, not re-executed)
    expect(cachedTs2).toBe(cachedTs1);
    // Server timestamp is fresh (handler ran again, only the cached fn was skipped)
    expect(Number(serverTs2)).toBeGreaterThan(Number(serverTs1));
  });

  test("interleave: cached function with ReactNode slots returns frozen output on cache hit", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // First measured visit can still absorb one last dev-server settle cycle.
    let baseline = await readInterleaveSnapshot(page);
    let next: Awaited<ReturnType<typeof readInterleaveSnapshot>>;

    const cachedTs1 = baseline.cachedTs;
    const cachedRand1 = baseline.cachedRand;
    const headerContent1 = baseline.headerContent;
    const childrenContent1 = baseline.childrenContent;

    expect(cachedTs1).toMatch(/^\d+$/);
    expect(cachedRand1).toMatch(/^0\.\d+$/);
    expect(headerContent1).toMatch(/^.+$/);

    // Header and children should show the same dynamicTs
    expect(headerContent1).toBe(childrenContent1);

    await navigateHome(page);
    next = await readInterleaveSnapshot(page);

    if (next.cachedTs !== baseline.cachedTs) {
      baseline = next;
      await navigateHome(page);
      next = await readInterleaveSnapshot(page);
    }

    const cachedTs2 = next.cachedTs;
    const cachedRand2 = next.cachedRand;
    const headerContent2 = next.headerContent;
    const childrenContent2 = next.childrenContent;
    const serverTs2 = next.serverTs;
    const serverTs1 = baseline.serverTs;

    // Cached function data is frozen (cache hit)
    expect(cachedTs2).toBe(baseline.cachedTs);
    expect(cachedRand2).toBe(baseline.cachedRand);

    // Slot content is also frozen (part of cached output)
    expect(headerContent2).toBe(baseline.headerContent);
    expect(childrenContent2).toBe(baseline.childrenContent);

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
