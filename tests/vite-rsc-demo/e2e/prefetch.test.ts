import { test, expect, devURL } from "./dev-fixture";
import { test as base, expect as baseExpect } from "@playwright/test";
import { waitForHydration, expectNoPageError } from "./helper";
import { useFixture } from "./fixture";

/**
 * Prefetch on hover tests (router mode — default)
 *
 * Verifies that prefetch="hover" on Link components triggers a fetch() request
 * to the RSC partial URL on mouseenter, with X-Rango-State header.
 * No <link rel="prefetch"> elements should be created in router mode.
 */
test.describe("prefetch-on-hover (router mode)", () => {
  test("should fetch RSC partial on hover", async ({ page, devServerURL }) => {
    using _ = expectNoPageError(page);

    await page.goto(devURL(devServerURL, "/"));
    await waitForHydration(page);

    // Collect prefetch requests
    const prefetchRequests: { url: string; headers: Record<string, string> }[] =
      [];
    page.on("request", (request) => {
      const url = request.url();
      if (url.includes("_rsc_partial") && url.includes("/blog")) {
        prefetchRequests.push({
          url,
          headers: request.headers(),
        });
      }
    });

    // Hover over the Blog nav link
    const blogLink = page.locator('nav a:has-text("Blog")');
    await blogLink.hover();

    // Wait for the prefetch request to be made
    await expect
      .poll(() => prefetchRequests.length, { timeout: 3000 })
      .toBeGreaterThan(0);

    // Verify the request has _rsc_partial and X-Rango-State header
    const req = prefetchRequests[0]!;
    expect(req.url).toContain("_rsc_partial=true");
    expect(req.headers["x-rango-state"]).toBeDefined();

    // Verify no <link rel="prefetch"> elements were created (router mode)
    const prefetchLinkCount = await page.evaluate(
      () =>
        document.querySelectorAll('link[rel="prefetch"][href*="/blog"]').length,
    );
    expect(prefetchLinkCount).toBe(0);
  });

  test("should not make duplicate prefetch requests on repeated hover", async ({
    page,
    devServerURL,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(devURL(devServerURL, "/"));
    await waitForHydration(page);

    const prefetchRequests: string[] = [];
    page.on("request", (request) => {
      const url = request.url();
      if (url.includes("_rsc_partial") && url.includes("/blog")) {
        prefetchRequests.push(url);
      }
    });

    const blogLink = page.locator('nav a:has-text("Blog")');

    // Hover, move away, hover again
    await blogLink.hover();
    await page.waitForTimeout(300);

    // Move away from the link
    await page.locator("h1").first().hover();
    await page.waitForTimeout(200);

    // Hover again
    await blogLink.hover();
    await page.waitForTimeout(300);

    // Only one prefetch request should have been made
    expect(prefetchRequests.length).toBe(1);
  });

  test("should prefetch multiple links independently", async ({
    page,
    devServerURL,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(devURL(devServerURL, "/"));
    await waitForHydration(page);

    const prefetchUrls: string[] = [];
    page.on("request", (request) => {
      const url = request.url();
      if (url.includes("_rsc_partial")) {
        prefetchUrls.push(url);
      }
    });

    // Hover over Blog link
    await page.locator('nav a:has-text("Blog")').hover();
    await page.waitForTimeout(300);

    // Hover over Shop link
    await page.locator('nav a:has-text("Shop")').hover();
    await page.waitForTimeout(300);

    // Both prefetch requests should have been made
    const blogPrefetches = prefetchUrls.filter((u) => u.includes("/blog"));
    const shopPrefetches = prefetchUrls.filter((u) => u.includes("/shop"));

    expect(blogPrefetches.length).toBe(1);
    expect(shopPrefetches.length).toBe(1);
  });

  test("should use cached prefetch response on navigation (no second fetch)", async ({
    page,
    devServerURL,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(devURL(devServerURL, "/"));
    await waitForHydration(page);

    // Track all RSC partial requests for /blog
    const rscRequests: { url: string; headers: Record<string, string> }[] = [];
    page.on("request", (request) => {
      const url = request.url();
      if (url.includes("_rsc_partial") && url.includes("/blog")) {
        rscRequests.push({ url, headers: request.headers() });
      }
    });

    // Hover to trigger prefetch
    const blogLink = page.locator('nav a:has-text("Blog")');
    await blogLink.hover();

    // Wait for prefetch request to complete (response received)
    await expect.poll(() => rscRequests.length, { timeout: 3000 }).toBe(1);
    // Wait for the prefetch response to be stored in cache
    await page.waitForTimeout(200);

    // Click the link to navigate
    await blogLink.click();

    // Verify navigation completed — we should be on /blog
    await page.waitForURL("**/blog", { timeout: 5000 });

    // Wait a bit for any potential late requests
    await page.waitForTimeout(300);

    // Only 1 RSC request should have been made (the prefetch).
    // Navigation should have consumed the cached response.
    expect(rscRequests.length).toBe(1);

    // Verify the single request was the prefetch (has X-Rango-State)
    expect(rscRequests[0]!.headers["x-rango-state"]).toBeDefined();
  });

  test("should return RSC Flight for partial request with Accept: text/html", async ({
    devServerURL,
  }) => {
    // Chrome sends Accept: text/html for <link rel="prefetch" as="fetch">.
    // Partial requests (_rsc_partial) must always return RSC Flight regardless
    // of Accept header — they are client-side navigation/prefetch requests.
    const url = new URL("/shop", devServerURL);
    url.searchParams.set("_rsc_partial", "true");

    const res = await fetch(url, {
      headers: {
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
      },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/x-component");
  });

  test("should include Vary: X-Rango-State for prefetch requests", async ({
    devServerURL,
  }) => {
    // Prefetch requests include X-Rango-State header.
    // Server should add X-Rango-State to Vary to prevent HTTP cache collisions.
    const url = new URL("/shop", devServerURL);
    url.searchParams.set("_rsc_partial", "true");

    const res = await fetch(url, {
      headers: {
        "X-Rango-State": String(Date.now()),
      },
    });

    expect(res.status).toBe(200);
    const vary = res.headers.get("vary");
    expect(vary).toContain("X-Rango-State");
  });

  test("should re-prefetch after server action invalidates cache", async ({
    page,
    devServerURL,
  }) => {
    test.setTimeout(30000);
    using _ = expectNoPageError(page);

    await page.goto(devURL(devServerURL, "/todos"));
    await waitForHydration(page);

    // Wait for the todos page to fully load (loader has latency)
    await expect(page.locator("button:has-text('Add Todo')")).toBeVisible({
      timeout: 15000,
    });

    // Track prefetch requests for /blog
    const prefetchRequests: string[] = [];
    page.on("request", (request) => {
      const url = request.url();
      if (url.includes("_rsc_partial") && url.includes("/blog")) {
        prefetchRequests.push(url);
      }
    });

    // Hover Blog link to trigger prefetch
    const blogLink = page.locator('nav a:has-text("Blog")');
    await blogLink.hover();

    // Wait for prefetch to complete
    await expect.poll(() => prefetchRequests.length, { timeout: 3000 }).toBe(1);
    await page.waitForTimeout(200);

    // Move cursor away from Blog link
    await page.locator("h1").first().hover();
    await page.waitForTimeout(200);

    // Perform server action: add a todo
    // This triggers markCacheAsStale -> clearPrefetchCache
    const input = page.locator('input[placeholder="What needs to be done?"]');
    await input.fill("Prefetch Invalidation Test");
    await page.locator("button:has-text('Add Todo')").click();

    // Wait for action to complete (button returns to "Add Todo")
    await expect(page.locator("button:has-text('Add Todo')")).toBeVisible({
      timeout: 10000,
    });
    await page.waitForTimeout(300);

    // Hover Blog link again — should trigger a NEW prefetch
    // because the cache was cleared by the server action
    await blogLink.hover();

    await expect.poll(() => prefetchRequests.length, { timeout: 3000 }).toBe(2);
  });
});

/**
 * Prefetch on hover (production — router mode)
 */
base.describe("prefetch-on-hover (production)", () => {
  const f = useFixture({
    root: ".",
    mode: "build",
  });

  base.setTimeout(120000);

  base("should fetch RSC partial on hover", async ({ page }) => {
    await page.goto(f.url("/"));
    await waitForHydration(page);

    const prefetchRequests: { url: string; headers: Record<string, string> }[] =
      [];
    page.on("request", (request) => {
      const url = request.url();
      if (url.includes("_rsc_partial") && url.includes("/blog")) {
        prefetchRequests.push({
          url,
          headers: request.headers(),
        });
      }
    });

    const blogLink = page.locator('nav a:has-text("Blog")');
    await blogLink.hover();

    await baseExpect
      .poll(() => prefetchRequests.length, { timeout: 3000 })
      .toBeGreaterThan(0);

    const req = prefetchRequests[0]!;
    baseExpect(req.url).toContain("_rsc_partial=true");
    baseExpect(req.headers["x-rango-state"]).toBeDefined();

    // No <link rel="prefetch"> elements in router mode
    const prefetchLinkCount = await page.evaluate(
      () =>
        document.querySelectorAll('link[rel="prefetch"][href*="/blog"]').length,
    );
    baseExpect(prefetchLinkCount).toBe(0);
  });

  base(
    "should use cached prefetch response on navigation (no second fetch)",
    async ({ page }) => {
      await page.goto(f.url("/"));
      await waitForHydration(page);

      const rscRequests: { url: string; headers: Record<string, string> }[] =
        [];
      page.on("request", (request) => {
        const url = request.url();
        if (url.includes("_rsc_partial") && url.includes("/blog")) {
          rscRequests.push({ url, headers: request.headers() });
        }
      });

      const blogLink = page.locator('nav a:has-text("Blog")');
      await blogLink.hover();

      await baseExpect
        .poll(() => rscRequests.length, { timeout: 3000 })
        .toBe(1);
      await page.waitForTimeout(200);

      await blogLink.click();
      await page.waitForURL("**/blog", { timeout: 5000 });
      await page.waitForTimeout(300);

      baseExpect(rscRequests.length).toBe(1);
      baseExpect(rscRequests[0]!.headers["x-rango-state"]).toBeDefined();
    },
  );

  base(
    "should return RSC Flight for partial request with Accept: text/html",
    async () => {
      const url = new URL("/shop", f.url("/"));
      url.searchParams.set("_rsc_partial", "true");

      const res = await fetch(url, {
        headers: {
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
        },
      });

      baseExpect(res.status).toBe(200);
      baseExpect(res.headers.get("content-type")).toContain("text/x-component");
    },
  );

  base("should include Vary: X-Rango-State for prefetch requests", async () => {
    const url = new URL("/shop", f.url("/"));
    url.searchParams.set("_rsc_partial", "true");

    const res = await fetch(url, {
      headers: {
        "X-Rango-State": String(Date.now()),
      },
    });

    baseExpect(res.status).toBe(200);
    const vary = res.headers.get("vary");
    baseExpect(vary).toContain("X-Rango-State");
  });

  base(
    "should re-prefetch after server action invalidates cache",
    async ({ page }) => {
      base.setTimeout(60000);

      await page.goto(f.url("/todos"));
      await waitForHydration(page);

      // Wait for the todos page to fully load (loader has latency)
      await baseExpect(page.locator("button:has-text('Add Todo')")).toBeVisible(
        { timeout: 15000 },
      );

      // Track prefetch requests for /blog
      const prefetchRequests: string[] = [];
      page.on("request", (request) => {
        const url = request.url();
        if (url.includes("_rsc_partial") && url.includes("/blog")) {
          prefetchRequests.push(url);
        }
      });

      // Hover Blog link to trigger prefetch
      const blogLink = page.locator('nav a:has-text("Blog")');
      await blogLink.hover();

      // Wait for prefetch to complete
      await baseExpect
        .poll(() => prefetchRequests.length, { timeout: 3000 })
        .toBe(1);
      await page.waitForTimeout(200);

      // Move cursor away from Blog link
      await page.locator("h1").first().hover();
      await page.waitForTimeout(200);

      // Perform server action: add a todo
      // This triggers markCacheAsStale -> clearPrefetchCache
      const input = page.locator('input[placeholder="What needs to be done?"]');
      await input.fill("Prefetch Invalidation Test");
      await page.locator("button:has-text('Add Todo')").click();

      // Wait for action to complete (button returns to "Add Todo")
      await baseExpect(page.locator("button:has-text('Add Todo')")).toBeVisible(
        { timeout: 10000 },
      );
      await page.waitForTimeout(300);

      // Hover Blog link again — should trigger a NEW prefetch
      // because the cache was cleared by the server action
      await blogLink.hover();

      await baseExpect
        .poll(() => prefetchRequests.length, { timeout: 3000 })
        .toBe(2);
    },
  );
});
