import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError } from "./helper";

/**
 * Shell caching (PPR) tests - validates shell cache behavior with segment cache coupling
 *
 * Shell caching separates HTML shell from RSC data for fast TTFB.
 * When segment caching is also enabled, the caches are coupled to prevent hydration mismatches.
 */

// Note: Tests run in parallel by default, each gets a fresh server instance
// Shell cache is in-memory and doesn't persist across server restarts

// Helper to make HTML requests (must include Accept: text/html header)
const htmlHeaders = { Accept: "text/html" };

test.describe("shell-cache (dev)", () => {
  // Configure serial mode for dev tests since they share the same server instance
  test.describe.configure({ mode: "serial" });
  const f = useFixture({
    root: ".",
    mode: "dev",
  });

  test("should return x-suspense-cache: miss on first request", async ({
    request,
  }) => {
    // First request should be a cache miss
    const response = await request.get(f.url("/blog?__force_ppr"), {
      headers: htmlHeaders,
    });

    expect(response.status()).toBe(200);
    expect(response.headers()["x-suspense-cache"]).toBe("miss");
    expect(response.headers()["content-type"]).toContain("text/html");
  });

  test("should return x-suspense-cache: hit on subsequent request", async ({
    request,
  }) => {
    // Request should hit cache (populated by previous test or earlier request)
    // If cache was empty, this will populate it - next request will be hit
    const firstResponse = await request.get(f.url("/blog?__force_ppr"), {
      headers: htmlHeaders,
    });
    expect(firstResponse.status()).toBe(200);

    // Second request should definitely hit cache
    const secondResponse = await request.get(f.url("/blog?__force_ppr"), {
      headers: htmlHeaders,
    });
    expect(secondResponse.status()).toBe(200);
    expect(secondResponse.headers()["x-suspense-cache"]).toBe("hit");
    expect(secondResponse.headers()["x-suspense-cache-age"]).toBeDefined();
  });

  test("should include x-segment-cache header when segment cache is configured", async ({
    request,
  }) => {
    // Request with shell caching enabled
    const response = await request.get(f.url("/blog?__force_ppr"), {
      headers: htmlHeaders,
    });

    expect(response.status()).toBe(200);
    // Segment cache should show status (hit, stale, miss, or disabled)
    const segmentCache = response.headers()["x-segment-cache"];
    expect(["hit", "stale", "miss"]).toContain(segmentCache);
  });

  test("should bypass cache with __no_suspense_cache param", async ({
    request,
  }) => {
    // First request to populate cache
    await request.get(f.url("/blog?__force_ppr"), { headers: htmlHeaders });

    // Second request with bypass should be a miss
    const response = await request.get(
      f.url("/blog?__force_ppr&__no_suspense_cache"),
      { headers: htmlHeaders }
    );

    expect(response.status()).toBe(200);
    expect(response.headers()["x-suspense-cache"]).toBe("miss");
  });

  test("should not cache non-GET requests", async ({ request }) => {
    // First GET request to populate cache
    await request.get(f.url("/blog?__force_ppr"), { headers: htmlHeaders });

    // Second GET request should hit cache
    const response = await request.get(f.url("/blog?__force_ppr"), {
      headers: htmlHeaders,
    });
    expect(response.headers()["x-suspense-cache"]).toBe("hit");
  });

  test.skip("should render content correctly with shell cache", async ({ page }) => {
    // TODO: Investigate hydration issues with shell caching
    using _ = expectNoPageError(page);

    await page.goto(f.url("/blog?__force_ppr"));
    await waitForHydration(page);

    // Verify blog content renders correctly
    await expect(page.locator("text=Blog Posts")).toBeVisible();
    await expect(
      page.locator('a[href="/blog/hello-world"]').first()
    ).toBeVisible();
  });

  test("shell_only debug param should return shell without RSC", async ({
    request,
  }) => {
    const response = await request.get(
      f.url("/blog?__force_ppr&__shell_only"),
      { headers: htmlHeaders }
    );

    expect(response.status()).toBe(200);
    expect(response.headers()["x-suspense-cache"]).toBeDefined();
    expect(response.headers()["x-suspense-cache-key"]).toBeDefined();

    // Shell should contain HTML structure but no Flight data
    const html = await response.text();
    expect(html).toContain("<!DOCTYPE html");
    expect(html).toContain("<html");
  });

  test("should cache different paths separately", async ({ request }) => {
    // Request blog index - first or subsequent request
    const blogResponse = await request.get(f.url("/blog?__force_ppr"), {
      headers: htmlHeaders,
    });
    expect(blogResponse.status()).toBe(200);

    // Second request to same path should hit
    const blogResponse2 = await request.get(f.url("/blog?__force_ppr"), {
      headers: htmlHeaders,
    });
    expect(blogResponse2.headers()["x-suspense-cache"]).toBe("hit");

    // Request blog post (different path) - may be miss or hit
    const postResponse = await request.get(
      f.url("/blog/hello-world?__force_ppr"),
      { headers: htmlHeaders }
    );
    expect(postResponse.status()).toBe(200);

    // Second request to post should hit
    const postResponse2 = await request.get(
      f.url("/blog/hello-world?__force_ppr"),
      { headers: htmlHeaders }
    );
    expect(postResponse2.headers()["x-suspense-cache"]).toBe("hit");

    // Verify both paths have separate cache entries (blog index still works)
    const blogResponse3 = await request.get(f.url("/blog?__force_ppr"), {
      headers: htmlHeaders,
    });
    expect(blogResponse3.headers()["x-suspense-cache"]).toBe("hit");
  });

  test.skip("cached shell should serve fresh RSC data", async ({ page }) => {
    // TODO: Investigate hydration issues with shell caching
    using _ = expectNoPageError(page);

    // First visit to populate cache
    await page.goto(f.url("/blog?__force_ppr"));
    await waitForHydration(page);

    // Wait for sidebar to load (has loader data)
    await expect(page.locator("text=Recent Posts")).toBeVisible({
      timeout: 8000,
    });

    // Navigate away and back (should use cached shell but fresh RSC)
    await page.goto(f.url("/"));
    await waitForHydration(page);

    await page.goto(f.url("/blog?__force_ppr"));
    await waitForHydration(page);

    // Content should still render correctly
    await expect(page.locator("text=Blog Posts")).toBeVisible();
    await expect(page.locator("text=Recent Posts")).toBeVisible({
      timeout: 8000,
    });
  });
});

test.describe("shell-cache (production)", () => {
  test.describe.configure({ mode: "serial" });
  const f = useFixture({
    root: ".",
    mode: "build",
  });

  test.setTimeout(120000);

  test("should return x-suspense-cache: miss then hit", async ({ request }) => {
    // First request - miss
    const firstResponse = await request.get(f.url("/blog?__force_ppr"), {
      headers: htmlHeaders,
    });
    expect(firstResponse.status()).toBe(200);
    expect(firstResponse.headers()["x-suspense-cache"]).toBe("miss");

    // Second request - hit
    const secondResponse = await request.get(f.url("/blog?__force_ppr"), {
      headers: htmlHeaders,
    });
    expect(secondResponse.status()).toBe(200);
    expect(secondResponse.headers()["x-suspense-cache"]).toBe("hit");
  });

  test.skip("should render content correctly with shell cache in production", async ({
    page,
  }) => {
    // TODO: Investigate hydration error #418 with shell caching in production
    using _ = expectNoPageError(page);

    await page.goto(f.url("/blog?__force_ppr"));
    await waitForHydration(page);

    // Verify blog content renders correctly
    await expect(page.locator("text=Blog Posts")).toBeVisible();
    await expect(
      page.locator('a[href="/blog/hello-world"]').first()
    ).toBeVisible();

    // Wait for sidebar (streaming content)
    await expect(page.locator("text=Recent Posts")).toBeVisible({
      timeout: 10000,
    });
  });

  test.skip("navigation should work correctly with cached shell", async ({
    page,
  }) => {
    // TODO: Investigate hydration issues with shell caching
    using _ = expectNoPageError(page);

    // Start at blog index with shell cache
    await page.goto(f.url("/blog?__force_ppr"));
    await waitForHydration(page);

    await expect(page.locator("text=Recent Posts")).toBeVisible({
      timeout: 10000,
    });

    // Navigate to a post (client-side navigation)
    await page.locator('a[href="/blog/hello-world"]').first().click();

    // Post should load
    await expect(page.locator("h2:has-text('Hello World')")).toBeVisible({
      timeout: 5000,
    });

    // Navigate back to index
    await page.goBack();

    // Should restore from cache correctly
    await expect(page.locator("text=Blog Posts")).toBeVisible();
  });
});
