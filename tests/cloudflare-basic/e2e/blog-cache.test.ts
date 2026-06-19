import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import {
  waitForHydration,
  expectNoPageError,
  testId,
  expectNoReload,
} from "./helper";

test.describe.configure({ mode: "serial" });

// Blog routes wrapped in cache({ ttl: 60, swr: 300 }) with a parallel,
// cache()-backed sidebar loader. The content (post titles/authors, sidebar
// links/tags) is deterministic, and the cache-stability assertion (the sidebar
// timestamp is preserved across an in-layout navigation) is an invariant of the
// cache() boundary that holds identically in dev and the production
// CFCacheStore. Covered in BOTH dev and production (build) modes.
function describeBlogCache(mode: "dev" | "build") {
  const label = mode === "build" ? "production" : "dev";
  test.describe(`blog with CF cache (${label})`, () => {
    const f = useFixture({
      root: ".",
      mode,
    });

    test("should render blog index with posts list", async ({ page }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/blog"));
      await waitForHydration(page);

      // Blog layout should be visible
      await expect(testId(page, "blog-layout")).toBeVisible();

      // Blog index content
      await expect(testId(page, "blog-title")).toHaveText("Blog");
      await expect(testId(page, "blog-posts-list")).toBeVisible();

      // Should show all 3 blog posts
      await expect(
        testId(page, "blog-post-getting-started-with-rsc"),
      ).toBeVisible();
      await expect(
        testId(page, "blog-post-cloudflare-workers-deployment"),
      ).toBeVisible();
      await expect(
        testId(page, "blog-post-understanding-caching-strategies"),
      ).toBeVisible();
    });

    test("should stream sidebar with skeleton then content", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      // Navigate fresh to blog page
      await page.goto(f.url("/blog"));

      // Sidebar skeleton should appear first (streaming)
      // Note: May be too fast to catch in dev mode, so we check either skeleton or final content
      const skeletonOrContent = page.locator(
        '[data-testid="sidebar-skeleton"], [data-testid="blog-sidebar"]',
      );
      await expect(skeletonOrContent.first()).toBeVisible({ timeout: 5000 });

      // Wait for sidebar to fully load
      await expect(testId(page, "blog-sidebar")).toBeVisible({
        timeout: 10000,
      });

      // Sidebar should show recent posts
      await expect(
        testId(page, "sidebar-link-getting-started-with-rsc"),
      ).toBeVisible();
      await expect(
        testId(page, "sidebar-link-cloudflare-workers-deployment"),
      ).toBeVisible();

      // Sidebar should show popular tags
      await expect(testId(page, "sidebar-tag-react")).toBeVisible();
      await expect(testId(page, "sidebar-tag-cloudflare")).toBeVisible();

      // Sidebar should show rendered timestamp
      await expect(testId(page, "sidebar-rendered-at")).toBeVisible();
    });

    test("should navigate to blog post detail page", async ({ page }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/blog"));
      await waitForHydration(page);

      // Wait for sidebar to load (streaming complete)
      await expect(testId(page, "blog-sidebar")).toBeVisible({
        timeout: 10000,
      });

      await using __ = await expectNoReload(page);

      // Click on first blog post link
      await testId(page, "blog-link-getting-started-with-rsc").click();

      // Should navigate to blog post detail
      await expect(page).toHaveURL(/\/blog\/getting-started-with-rsc/);
      await expect(testId(page, "blog-post-detail")).toBeVisible();
      await expect(testId(page, "post-title")).toHaveText(
        "Getting Started with React Server Components",
      );
      await expect(testId(page, "post-author")).toHaveText("RSC Team");
      await expect(testId(page, "post-content")).toContainText(
        "React Server Components",
      );
    });

    test("should preserve sidebar during navigation to post", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/blog"));
      await waitForHydration(page);

      // Wait for sidebar to load
      await expect(testId(page, "blog-sidebar")).toBeVisible({
        timeout: 10000,
      });

      // Get sidebar timestamp before navigation
      const sidebarTimeBefore = await testId(
        page,
        "sidebar-rendered-at",
      ).textContent();

      await using __ = await expectNoReload(page);

      // Navigate to post
      await testId(page, "blog-link-cloudflare-workers-deployment").click();
      await expect(testId(page, "blog-post-detail")).toBeVisible();

      // Sidebar should still be visible
      await expect(testId(page, "blog-sidebar")).toBeVisible();

      // Sidebar timestamp should be preserved (same as before - from cache)
      const sidebarTimeAfter = await testId(
        page,
        "sidebar-rendered-at",
      ).textContent();
      expect(sidebarTimeBefore).toBe(sidebarTimeAfter);
    });

    test("should render blog post directly via URL", async ({ page }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/blog/understanding-caching-strategies"));
      await waitForHydration(page);

      // Should render post detail
      await expect(testId(page, "blog-post-detail")).toBeVisible();
      await expect(testId(page, "post-title")).toHaveText(
        "Understanding RSC Caching Strategies",
      );
      await expect(testId(page, "post-content")).toContainText(
        "Caching is crucial",
      );

      // Sidebar should also load
      await expect(testId(page, "blog-sidebar")).toBeVisible({
        timeout: 10000,
      });
    });

    // Flaky only in serial dev mode: hydration fails after repeated blog visits
    // in the same suite (raw RSC payload). Passes in isolation and production,
    // so skip in dev (module-runner state corruption) but run the production
    // build, which is where this navigation must keep working.
    test("should navigate back to blog index from post", async ({ page }) => {
      test.fixme(
        mode === "dev",
        "dev module-runner state corruption on repeated blog visits in serial",
      );
      using _ = expectNoPageError(page);

      await page.goto(f.url("/blog/getting-started-with-rsc"));
      await waitForHydration(page);

      // Wait for full page load including sidebar
      await expect(testId(page, "blog-sidebar")).toBeVisible({
        timeout: 10000,
      });

      await using __ = await expectNoReload(page);

      // Click back link
      await page.click('a:has-text("Back to Blog")');

      // Should navigate back to index
      await expect(page).toHaveURL(/\/blog$/);
      await expect(testId(page, "blog-index")).toBeVisible();
      await expect(testId(page, "blog-title")).toHaveText("Blog");
    });

    test("should show cache info timestamp", async ({ page }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/blog"));
      await waitForHydration(page);

      // Cache info should show rendered timestamp
      await expect(testId(page, "cache-info")).toContainText("Rendered at:");
      await expect(testId(page, "cache-info")).toContainText("TTL=60s");
    });

    test("sidebar links should navigate to posts", async ({ page }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/blog"));
      await waitForHydration(page);

      // Wait for sidebar
      await expect(testId(page, "blog-sidebar")).toBeVisible({
        timeout: 10000,
      });

      await using __ = await expectNoReload(page);

      // Click sidebar link
      await testId(page, "sidebar-link-cloudflare-workers-deployment").click();

      // Should navigate to that post
      await expect(page).toHaveURL(/\/blog\/cloudflare-workers-deployment/);
      await expect(testId(page, "post-title")).toHaveText(
        "Deploying RSC to Cloudflare Workers",
      );
    });
  });
}

describeBlogCache("dev");
describeBlogCache("build");

test.describe("proactive-caching", () => {
  const f = useFixture({
    root: ".",
    mode: "dev",
    isolatedServer: true,
    cliOptions: { env: { INTERNAL_RANGO_DEBUG: "1" } },
  });

  test("proactive caching triggers when navigating within cached layout", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // Step 1: Document request to item-a
    const beforeFirstVisit = f.proc().stdout();
    await page.goto(f.url("/proactive-cache/item-a"));
    await waitForHydration(page);
    const afterFirstVisit = f.proc().stdout();
    const firstVisitLogs = afterFirstVisit.slice(beforeFirstVisit.length);

    // Verify layout and content rendered
    await expect(testId(page, "proactive-cache-layout")).toBeVisible();
    await expect(testId(page, "proactive-item-a-page")).toBeVisible();

    // Should have cache interaction (MISS on fresh cache, HIT on warmed cache)
    expect(firstVisitLogs).toContain("[CacheScope]");

    // Step 2: Partial navigation to item-b (within same layout)
    // This triggers proactive caching because layout has null component
    // (unless doc entry already exists from previous run, in which case it skips)
    const beforePartialNav = f.proc().stdout();
    await testId(page, "proactive-nav-b").click();
    await expect(testId(page, "proactive-item-b-page")).toBeVisible();

    // Give proactive caching time to complete in background
    await page.waitForTimeout(500);

    const afterPartialNav = f.proc().stdout();
    const partialNavLogs = afterPartialNav.slice(beforePartialNav.length);

    // Check for valid cache interaction during partial navigation:
    // - "[CacheScope] Cached:" = proactive caching completed and stored segments
    // - "HIT: partial:" = partial cache hit, served from cache (already has complete segments)
    // Both are valid outcomes depending on cache state
    const proactiveCached = partialNavLogs.includes("[CacheScope] Cached:");
    const partialCacheHit = partialNavLogs.includes("HIT: partial:");
    expect(proactiveCached || partialCacheHit).toBe(true);

    // Step 3: Verify cache serves frozen content by comparing timestamps.
    // Navigate away, then partial-nav to item-b twice — both should return the
    // same cached render timestamp (proving segments come from cache, not re-rendered).
    await page.goto(f.url("/proactive-cache"));
    await waitForHydration(page);

    await testId(page, "proactive-nav-b").click();
    await expect(testId(page, "proactive-item-b-page")).toBeVisible();
    const firstCachedTimestamp = await testId(
      page,
      "proactive-item-b-rendered",
    ).textContent();

    await testId(page, "proactive-nav-index").click();
    await expect(testId(page, "proactive-index-page")).toBeVisible();

    await testId(page, "proactive-nav-b").click();
    await expect(testId(page, "proactive-item-b-page")).toBeVisible();
    const secondCachedTimestamp = await testId(
      page,
      "proactive-item-b-rendered",
    ).textContent();

    expect(secondCachedTimestamp).toBe(firstCachedTimestamp);
  });

  test("layout renders correctly after proactive caching", async ({ page }) => {
    using _ = expectNoPageError(page);

    // Step 1: Document request to index (populates cache)
    await page.goto(f.url("/proactive-cache"));
    await waitForHydration(page);
    await expect(testId(page, "proactive-cache-layout")).toBeVisible();
    await expect(testId(page, "proactive-index-page")).toBeVisible();

    // Step 2: Partial nav to item-a (triggers proactive caching for layout)
    await testId(page, "proactive-nav-a").click();
    await expect(testId(page, "proactive-item-a-page")).toBeVisible();

    // Wait for proactive caching to complete
    await page.waitForTimeout(500);

    // Step 3: Navigate to home (outside cached layout)
    await testId(page, "proactive-back-home").click();
    await waitForHydration(page);

    // Step 4: Hard navigate to item-a
    // Should use cached layout from proactive caching (not broken null components)
    await page.goto(f.url("/proactive-cache/item-a"));
    await waitForHydration(page);

    // Layout should be visible and functional
    await expect(testId(page, "proactive-cache-layout")).toBeVisible();
    await expect(testId(page, "proactive-layout-title")).toHaveText(
      "Proactive Cache Layout",
    );
    await expect(testId(page, "proactive-item-a-page")).toBeVisible();

    // Navigation within layout should work
    await testId(page, "proactive-nav-b").click();
    await expect(testId(page, "proactive-item-b-page")).toBeVisible();
  });
});

// Document (edge HTTP-response) caching via CFCacheStore. A served HIT must
// restore the route author's Cache-Control and must not leak the store's
// internal edge headers (x-edge-cache-stale-at / x-edge-cache-status) to the
// client. Runs against CFCacheStore in both dev and build.
function describeDocumentCacheHeaders(label: string, mode: "dev" | "build") {
  test.describe(`document-cache headers (${label})`, () => {
    // Dev uses an isolated server so the shared dev server's CF cache state
    // (mutated by the proactive-caching tests) cannot race this one.
    const f = useFixture({
      root: ".",
      mode,
      ...(mode === "dev" ? { isolatedServer: true } : {}),
    });

    test("served HIT restores the author's Cache-Control and hides internal edge headers", async ({
      request,
    }) => {
      // Poll until the background cache write lands and the route serves a HIT.
      let hitHeaders: Record<string, string> = {};
      await expect
        .poll(
          async () => {
            const res = await request.get(f.url("/document-cache"), {
              headers: { Accept: "text/html" },
            });
            hitHeaders = res.headers();
            return hitHeaders["x-document-cache-status"];
          },
          {
            timeout: 15000,
            message: "Expected /document-cache to serve a HIT",
          },
        )
        .toBe("HIT");

      // Internal edge headers must never reach the client.
      expect(hitHeaders["x-edge-cache-stale-at"]).toBeUndefined();
      expect(hitHeaders["x-edge-cache-status"]).toBeUndefined();
      // The author's Cache-Control is restored — not the internal edge
      // `public, max-age=<ttl+swr>` the store uses to retain the entry.
      expect(hitHeaders["cache-control"]).toBe(
        "s-maxage=60, stale-while-revalidate=300",
      );
    });
  });
}

describeDocumentCacheHeaders("dev", "dev");
describeDocumentCacheHeaders("production", "build");

// C3: an UNqualified `Cache-Control: no-cache` response must never be served
// as a fresh document-cache HIT (RFC 7234 §5.2.2.2). The route stamps a render
// timestamp and sets `no-cache, s-maxage=60`; the store must refuse to store
// it, so the status never reaches HIT and the timestamp re-executes each time —
// despite the s-maxage that would otherwise mark it cacheable.
function describeNoCacheNotStored(label: string, mode: "dev" | "build") {
  test.describe(`document-cache no-cache veto (${label})`, () => {
    const f = useFixture({
      root: ".",
      mode,
      ...(mode === "dev" ? { isolatedServer: true } : {}),
    });

    test("unqualified no-cache response is not served as a fresh HIT", async ({
      request,
    }) => {
      async function fetchOnce() {
        const res = await request.get(f.url("/document-cache-no-cache"), {
          headers: { Accept: "text/html" },
        });
        expect(res.status()).toBe(200);
        const headers = res.headers();
        const body = await res.text();
        // The render timestamp is an ISO string; SSR splits "Rendered at: "
        // and the date into adjacent nodes, so match the ISO token directly.
        const ts = body.match(/20\d{2}-\d{2}-\d{2}T[\d:.]+Z/)?.[0];
        expect(ts, "expected a rendered timestamp in the page").toBeTruthy();
        return { status: headers["x-document-cache-status"], ts };
      }

      // Give a (wrong) background store write the chance to land, then probe a
      // window of requests. The fix means none of them is ever a HIT and the
      // render timestamp keeps advancing.
      const first = await fetchOnce();
      const seenTimestamps = new Set<string>([first.ts!]);
      for (let i = 0; i < 4; i++) {
        await new Promise((r) => setTimeout(r, 60));
        const next = await fetchOnce();
        // The veto means the store never reports a fresh HIT for this route.
        expect(next.status).not.toBe("HIT");
        seenTimestamps.add(next.ts!);
      }

      // The handler re-executed: more than one distinct render timestamp.
      expect(seenTimestamps.size).toBeGreaterThan(1);
    });
  });
}

describeNoCacheNotStored("dev", "dev");
describeNoCacheNotStored("production", "build");

test.describe("proactive-caching (production)", () => {
  const f = useFixture({
    root: ".",
    mode: "build",
  });

  // The null-component corruption this guards against (a proactively-cached
  // layout served with a missing component) is store-level behavior, so it must
  // be exercised against the production CFCacheStore, not just the dev path.
  test("layout renders correctly after proactive caching", async ({ page }) => {
    using _ = expectNoPageError(page);

    // Populate the cache for the index, then partial-nav to item-a so the layout
    // is proactively cached (the partial response carries a null layout).
    await page.goto(f.url("/proactive-cache"));
    await waitForHydration(page);
    await expect(testId(page, "proactive-cache-layout")).toBeVisible();

    await testId(page, "proactive-nav-a").click();
    await expect(testId(page, "proactive-item-a-page")).toBeVisible();

    // Let the background proactive write settle (debug logs are off in prod).
    await page.waitForTimeout(800);

    await testId(page, "proactive-back-home").click();
    await waitForHydration(page);

    // Hard document request: the layout must come from the proactive cache with
    // a real component, not a null one. The toHaveText assertion is load-bearing
    // — a null-component corruption leaves the container present but empty.
    await page.goto(f.url("/proactive-cache/item-a"));
    await waitForHydration(page);

    await expect(testId(page, "proactive-cache-layout")).toBeVisible();
    await expect(testId(page, "proactive-layout-title")).toHaveText(
      "Proactive Cache Layout",
    );
    await expect(testId(page, "proactive-item-a-page")).toBeVisible();

    await testId(page, "proactive-nav-b").click();
    await expect(testId(page, "proactive-item-b-page")).toBeVisible();
  });
});
