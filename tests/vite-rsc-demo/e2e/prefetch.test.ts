import { test, expect, devURL } from "./dev-fixture";
import { test as base, expect as baseExpect } from "@playwright/test";
import { waitForHydration, expectNoPageError } from "./helper";
import { useFixture } from "./fixture";

type ExpectLike = typeof expect;

async function expectCountToRemain(
  expectFn: ExpectLike,
  getCount: () => number | Promise<number>,
  expected: number,
  durationMs = 500,
): Promise<void> {
  const start = Date.now();
  await expectFn
    .poll(
      async () =>
        (await getCount()) === expected && Date.now() - start >= durationMs,
      {
        timeout: durationMs + 3000,
        message: `Expected count to remain ${expected} for ${durationMs}ms`,
      },
    )
    .toBe(true);
}

/**
 * Prefetch on hover tests (router mode — default)
 *
 * Verifies that prefetch="hover" on Link components triggers a fetch() request
 * to the RSC partial URL on mouseenter, with X-Rango-State header from localStorage.
 * Both prefetch and navigation send the same X-Rango-State value so the browser
 * HTTP cache can serve the prefetch response for navigation.
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
      .poll(() => prefetchRequests.length, { timeout: 5000 })
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
    await expect.poll(() => prefetchRequests.length, { timeout: 5000 }).toBe(1);

    // Move away from the link
    await page.locator("h1").first().hover();

    // Hover again
    await blogLink.hover();

    // Only one prefetch request should have been made
    await expectCountToRemain(expect, () => prefetchRequests.length, 1);
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
    await expect
      .poll(() => prefetchUrls.filter((u) => u.includes("/blog")).length, {
        timeout: 5000,
      })
      .toBe(1);

    // Hover over Shop link
    await page.locator('nav a:has-text("Shop")').hover();
    await expect
      .poll(
        () => ({
          blog: prefetchUrls.filter((u) => u.includes("/blog")).length,
          shop: prefetchUrls.filter((u) => u.includes("/shop")).length,
        }),
        { timeout: 5000 },
      )
      .toEqual({ blog: 1, shop: 1 });

    // Both prefetch requests should have been made
    const blogPrefetches = prefetchUrls.filter((u) => u.includes("/blog"));
    const shopPrefetches = prefetchUrls.filter((u) => u.includes("/shop"));

    expect(blogPrefetches.length).toBe(1);
    expect(shopPrefetches.length).toBe(1);
  });

  test("should send same X-Rango-State on prefetch and navigation", async ({
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

    // Wait for prefetch request
    await expect.poll(() => rscRequests.length, { timeout: 5000 }).toBe(1);

    // Click the link to navigate
    await blogLink.click();

    // Verify navigation completed
    await page.waitForURL("**/blog", { timeout: 5000 });

    // With in-memory prefetch cache, navigation consumes the cached
    // response without making a second network request. Both prefetch
    // and navigation use matching X-Rango-State and X-RSC-Router-Client-Path.
    const prefetchState = rscRequests[0]!.headers["x-rango-state"];
    expect(prefetchState).toBeDefined();
    expect(rscRequests[0]!.headers["x-rango-prefetch"]).toBe("1");
    const prefetchClientPath =
      rscRequests[0]!.headers["x-rsc-router-client-path"];
    expect(prefetchClientPath).toBeDefined();

    // Navigation should use the in-memory cache (1 request = cache hit).
    // If the response wasn't fully buffered in time, navigation falls
    // back to a network fetch (2 requests = cache miss, still valid).
    expect(rscRequests.length).toBeGreaterThanOrEqual(1);
    expect(rscRequests.length).toBeLessThanOrEqual(2);

    // If navigation made a request (cache miss), verify same header values
    if (rscRequests.length > 1) {
      expect(rscRequests[1]!.headers["x-rango-state"]).toBe(prefetchState);
      expect(rscRequests[1]!.headers["x-rsc-router-client-path"]).toBe(
        prefetchClientPath,
      );
    }
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

  test("should always include Vary: X-Rango-State and X-RSC-Router-Client-Path on RSC responses", async ({
    devServerURL,
  }) => {
    // Vary should include X-Rango-State and X-RSC-Router-Client-Path on ALL RSC responses,
    // not just those with the headers — ensures consistent cache behavior.
    const url = new URL("/shop", devServerURL);
    url.searchParams.set("_rsc_partial", "true");

    // Request WITHOUT X-Rango-State header
    const res = await fetch(url);

    expect(res.status).toBe(200);
    const vary = res.headers.get("vary");
    expect(vary).toContain("X-Rango-State");
    expect(vary).toContain("X-RSC-Router-Client-Path");
  });

  test("should include Cache-Control only on prefetch partial responses", async ({
    devServerURL,
  }) => {
    const url = new URL("/shop", devServerURL);
    url.searchParams.set("_rsc_partial", "true");

    // Prefetch request (with X-Rango-Prefetch) should get Cache-Control
    const prefetchRes = await fetch(url, {
      headers: { "X-Rango-State": "test:1", "X-Rango-Prefetch": "1" },
    });
    expect(prefetchRes.status).toBe(200);
    const cc = prefetchRes.headers.get("cache-control");
    expect(cc).toContain("private");
    expect(cc).toContain("max-age=300");

    // Navigation request (without X-Rango-Prefetch) should NOT get Cache-Control
    const navRes = await fetch(url, {
      headers: { "X-Rango-State": "test:1" },
    });
    expect(navRes.status).toBe(200);
    expect(navRes.headers.get("cache-control")).toBeNull();
  });

  test("should not include Cache-Control on full page HTML requests", async ({
    devServerURL,
  }) => {
    const res = await fetch(devServerURL + "/shop", {
      headers: { Accept: "text/html" },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("cache-control")).toBeNull();
  });

  test("should re-prefetch after server action invalidates cache", async ({
    page,
    devServerURL,
  }) => {
    test.slow();
    using _ = expectNoPageError(page);

    await page.goto(devURL(devServerURL, "/todos"));
    await waitForHydration(page);

    // Wait for the todos page to fully load (loader has latency)
    await expect(page.locator("button:has-text('Add Todo')")).toBeVisible({
      timeout: 15000,
    });

    // Track prefetch requests for /blog and capture X-Rango-State values
    const prefetchStates: string[] = [];
    page.on("request", (request) => {
      const url = request.url();
      if (url.includes("_rsc_partial") && url.includes("/blog")) {
        prefetchStates.push(request.headers()["x-rango-state"] ?? "");
      }
    });

    // Hover Blog link to trigger prefetch
    const blogLink = page.locator('nav a:has-text("Blog")');
    await blogLink.hover();

    // Wait for prefetch to complete
    await expect.poll(() => prefetchStates.length, { timeout: 5000 }).toBe(1);

    // Move cursor away from Blog link
    await page.locator("h1").first().hover();

    // Perform server action: add a todo
    // This triggers markCacheAsStale -> clearPrefetchCache -> invalidateRangoState
    const input = page.locator('input[placeholder="What needs to be done?"]');
    await input.fill("Prefetch Invalidation Test");
    await page.locator("button:has-text('Add Todo')").click();

    // Wait for action to complete (button returns to "Add Todo")
    await expect(page.locator("button:has-text('Add Todo')")).toBeVisible({
      timeout: 10000,
    });

    await expect
      .poll(() => page.evaluate(() => localStorage.getItem("rango-state")), {
        timeout: 5000,
      })
      .not.toBe(prefetchStates[0]);

    // Hover Blog link again — should trigger a NEW prefetch
    // because the cache was cleared and state key changed
    await blogLink.hover();

    await expect.poll(() => prefetchStates.length, { timeout: 5000 }).toBe(2);

    // Verify the X-Rango-State value changed after invalidation
    expect(prefetchStates[0]).not.toBe(prefetchStates[1]);
  });

  test("should persist rango-state in localStorage across refresh", async ({
    page,
    devServerURL,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(devURL(devServerURL, "/"));
    await waitForHydration(page);

    // Read the initial state key from localStorage
    const initialState = await page.evaluate(() =>
      localStorage.getItem("rango-state"),
    );
    expect(initialState).toBeDefined();
    expect(initialState).toContain(":");

    // Trigger a prefetch to warm the browser cache
    const prefetchRequests: { headers: Record<string, string> }[] = [];
    page.on("request", (request) => {
      const url = request.url();
      if (url.includes("_rsc_partial") && url.includes("/blog")) {
        prefetchRequests.push({ headers: request.headers() });
      }
    });

    await page.locator('nav a:has-text("Blog")').hover();
    await expect.poll(() => prefetchRequests.length, { timeout: 5000 }).toBe(1);

    // Verify prefetch used the localStorage state key
    expect(prefetchRequests[0]!.headers["x-rango-state"]).toBe(initialState);

    // Reload the page
    await page.reload();
    await waitForHydration(page);

    // State key should persist across refresh
    const stateAfterReload = await page.evaluate(() =>
      localStorage.getItem("rango-state"),
    );
    expect(stateAfterReload).toBe(initialState);
  });

  test("should include version in rango-state key", async ({
    page,
    devServerURL,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(devURL(devServerURL, "/"));
    await waitForHydration(page);

    // Read the state key from localStorage
    const stateKey = await page.evaluate(() =>
      localStorage.getItem("rango-state"),
    );
    expect(stateKey).toBeDefined();

    // Format should be "{version}:{timestamp}"
    const parts = stateKey!.split(":");
    expect(parts.length).toBe(2);
    // Version part should be non-empty
    expect(parts[0]!.length).toBeGreaterThan(0);
    // Timestamp part should be numeric
    expect(Number(parts[1])).toBeGreaterThan(0);
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
      .poll(() => prefetchRequests.length, { timeout: 5000 })
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
    "should send same X-Rango-State on prefetch and navigation",
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
        .poll(() => rscRequests.length, { timeout: 5000 })
        .toBe(1);

      await blogLink.click();
      await baseExpect(page).toHaveURL(/\/blog/, { timeout: 10000 });

      // Both requests should share the same X-Rango-State value
      const prefetchState = rscRequests[0]!.headers["x-rango-state"];
      baseExpect(prefetchState).toBeDefined();
      baseExpect(rscRequests[0]!.headers["x-rango-prefetch"]).toBe("1");

      // Navigation should use the in-memory cache (1 request = cache hit).
      // If the response wasn't fully buffered in time, navigation falls
      // back to a network fetch (2 requests = cache miss, still valid).
      baseExpect(rscRequests.length).toBeGreaterThanOrEqual(1);
      baseExpect(rscRequests.length).toBeLessThanOrEqual(2);

      if (rscRequests.length > 1) {
        baseExpect(rscRequests[1]!.headers["x-rango-state"]).toBe(
          prefetchState,
        );
      }
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

  base(
    "should always include Vary: X-Rango-State and X-RSC-Router-Client-Path on RSC responses",
    async () => {
      const url = new URL("/shop", f.url("/"));
      url.searchParams.set("_rsc_partial", "true");

      // Request WITHOUT X-Rango-State header
      const res = await fetch(url);

      baseExpect(res.status).toBe(200);
      const vary = res.headers.get("vary");
      baseExpect(vary).toContain("X-Rango-State");
      baseExpect(vary).toContain("X-RSC-Router-Client-Path");
    },
  );

  base(
    "should include Cache-Control only on prefetch partial responses",
    async () => {
      const url = new URL("/shop", f.url("/"));
      url.searchParams.set("_rsc_partial", "true");

      // Prefetch request (with X-Rango-Prefetch) should get Cache-Control
      const prefetchRes = await fetch(url, {
        headers: { "X-Rango-State": "test:1", "X-Rango-Prefetch": "1" },
      });
      baseExpect(prefetchRes.status).toBe(200);
      const cc = prefetchRes.headers.get("cache-control");
      baseExpect(cc).toContain("private");
      baseExpect(cc).toContain("max-age=300");

      // Navigation request (without X-Rango-Prefetch) should NOT get Cache-Control
      const navRes = await fetch(url, {
        headers: { "X-Rango-State": "test:1" },
      });
      baseExpect(navRes.status).toBe(200);
      baseExpect(navRes.headers.get("cache-control")).toBeNull();
    },
  );

  base(
    "should not include Cache-Control on full page HTML requests",
    async () => {
      const res = await fetch(f.url("/shop"), {
        headers: { Accept: "text/html" },
      });

      baseExpect(res.status).toBe(200);
      baseExpect(res.headers.get("content-type")).toContain("text/html");
      baseExpect(res.headers.get("cache-control")).toBeNull();
    },
  );

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

      // Track prefetch requests and capture X-Rango-State values
      const prefetchStates: string[] = [];
      page.on("request", (request) => {
        const url = request.url();
        if (url.includes("_rsc_partial") && url.includes("/blog")) {
          prefetchStates.push(request.headers()["x-rango-state"] ?? "");
        }
      });

      // Hover Blog link to trigger prefetch
      const blogLink = page.locator('nav a:has-text("Blog")');
      await blogLink.hover();

      // Wait for prefetch to complete
      await baseExpect
        .poll(() => prefetchStates.length, { timeout: 5000 })
        .toBe(1);

      // Move cursor away from Blog link
      await page.locator("h1").first().hover();

      // Perform server action: add a todo
      const input = page.locator('input[placeholder="What needs to be done?"]');
      await input.fill("Prefetch Invalidation Test");
      await page.locator("button:has-text('Add Todo')").click();

      // Wait for action to complete (button returns to "Add Todo")
      await baseExpect(page.locator("button:has-text('Add Todo')")).toBeVisible(
        { timeout: 10000 },
      );

      await baseExpect
        .poll(() => page.evaluate(() => localStorage.getItem("rango-state")), {
          timeout: 5000,
        })
        .not.toBe(prefetchStates[0]);

      // Hover Blog link again — should trigger a NEW prefetch
      // because state key changed after invalidation
      await blogLink.hover();

      await baseExpect
        .poll(() => prefetchStates.length, { timeout: 5000 })
        .toBe(2);

      // Verify the X-Rango-State value changed after invalidation
      baseExpect(prefetchStates[0]).not.toBe(prefetchStates[1]);
    },
  );

  base(
    "should persist rango-state in localStorage across refresh",
    async ({ page }) => {
      await page.goto(f.url("/"));
      await waitForHydration(page);

      // Read initial state key
      const initialState = await page.evaluate(() =>
        localStorage.getItem("rango-state"),
      );
      baseExpect(initialState).toBeDefined();
      baseExpect(initialState).toContain(":");

      // Trigger a prefetch
      const prefetchRequests: { headers: Record<string, string> }[] = [];
      page.on("request", (request) => {
        const url = request.url();
        if (url.includes("_rsc_partial") && url.includes("/blog")) {
          prefetchRequests.push({ headers: request.headers() });
        }
      });

      await page.locator('nav a:has-text("Blog")').hover();
      await baseExpect
        .poll(() => prefetchRequests.length, { timeout: 5000 })
        .toBe(1);

      // Verify prefetch used the localStorage state key
      baseExpect(prefetchRequests[0]!.headers["x-rango-state"]).toBe(
        initialState,
      );

      // Reload the page
      await page.reload();
      await waitForHydration(page);

      // State key should persist
      const stateAfterReload = await page.evaluate(() =>
        localStorage.getItem("rango-state"),
      );
      baseExpect(stateAfterReload).toBe(initialState);
    },
  );

  base("should include version in rango-state key", async ({ page }) => {
    await page.goto(f.url("/"));
    await waitForHydration(page);

    const stateKey = await page.evaluate(() =>
      localStorage.getItem("rango-state"),
    );
    baseExpect(stateKey).toBeDefined();

    // Format: "{version}:{timestamp}"
    const parts = stateKey!.split(":");
    baseExpect(parts.length).toBe(2);
    baseExpect(parts[0]!.length).toBeGreaterThan(0);
    baseExpect(Number(parts[1])).toBeGreaterThan(0);
  });
});

/**
 * Viewport prefetch tests (dev)
 *
 * Verifies that prefetch="viewport" triggers a fetch when a link
 * enters the viewport, and does not fire for links that remain off-screen.
 */
test.describe("prefetch-viewport (dev)", () => {
  test("should prefetch when link is visible on page load", async ({
    page,
    devServerURL,
  }) => {
    using _ = expectNoPageError(page);

    // Track prefetch requests for /blog (viewport link visible on load)
    const prefetchRequests: string[] = [];
    page.on("request", (request) => {
      const url = request.url();
      if (url.includes("_rsc_partial") && url.includes("/blog")) {
        prefetchRequests.push(url);
      }
    });

    await page.goto(devURL(devServerURL, "/prefetch-test"));
    await waitForHydration(page);

    // The blog link has prefetch="viewport" and is visible on load.
    // After hydration completes (idle), IntersectionObserver should fire.
    await expect.poll(() => prefetchRequests.length, { timeout: 5000 }).toBe(1);
  });

  test("should not prefetch below-fold viewport link until scrolled", async ({
    page,
    devServerURL,
  }) => {
    using _ = expectNoPageError(page);

    const prefetchRequests: string[] = [];
    page.on("request", (request) => {
      const url = request.url();
      if (url.includes("_rsc_partial") && url.includes("/shop")) {
        prefetchRequests.push(url);
      }
    });

    await page.goto(devURL(devServerURL, "/prefetch-test"));
    await waitForHydration(page);

    // Wait for visible viewport links to fire
    await expectCountToRemain(expect, () => prefetchRequests.length, 0);

    // Shop link is below a 3000px spacer — should NOT have been prefetched
    expect(prefetchRequests.length).toBe(0);

    // Scroll to the bottom to bring the link into viewport
    await page
      .locator('[data-testid="viewport-below-fold"]')
      .scrollIntoViewIfNeeded();

    // Now the shop link should be prefetched
    await expect.poll(() => prefetchRequests.length, { timeout: 5000 }).toBe(1);
  });

  test("should prefetch render links on mount", async ({
    page,
    devServerURL,
  }) => {
    using _ = expectNoPageError(page);

    // Track prefetch requests for /about (render link)
    const prefetchRequests: string[] = [];
    page.on("request", (request) => {
      const url = request.url();
      if (url.includes("_rsc_partial") && url.includes("/about")) {
        prefetchRequests.push(url);
      }
    });

    await page.goto(devURL(devServerURL, "/prefetch-test"));
    await waitForHydration(page);

    // Render link should prefetch on mount (after idle)
    await expect.poll(() => prefetchRequests.length, { timeout: 5000 }).toBe(1);
  });

  test("should resolve adaptive to hover on desktop", async ({
    page,
    devServerURL,
  }) => {
    using _ = expectNoPageError(page);

    const prefetchRequests: string[] = [];
    page.on("request", (request) => {
      const url = request.url();
      if (url.includes("_rsc_partial") && url.includes("/magazine")) {
        prefetchRequests.push(url);
      }
    });

    await page.goto(devURL(devServerURL, "/prefetch-test"));
    await waitForHydration(page);

    // On desktop (pointer device), adaptive resolves to hover.
    // No prefetch should happen without hovering.
    await expectCountToRemain(expect, () => prefetchRequests.length, 0);
    expect(prefetchRequests.length).toBe(0);

    // Hover the adaptive link — should trigger prefetch
    await page.locator('a:has-text("Magazine (adaptive)")').hover();

    await expect.poll(() => prefetchRequests.length, { timeout: 5000 }).toBe(1);
  });
});

/**
 * Viewport prefetch tests (production)
 */
base.describe("prefetch-viewport (production)", () => {
  const f = useFixture({
    root: ".",
    mode: "build",
  });

  base.setTimeout(120000);

  base(
    "should prefetch when link is visible on page load",
    async ({ page }) => {
      const prefetchRequests: string[] = [];
      page.on("request", (request) => {
        const url = request.url();
        if (url.includes("_rsc_partial") && url.includes("/blog")) {
          prefetchRequests.push(url);
        }
      });

      await page.goto(f.url("/prefetch-test"));
      await waitForHydration(page);

      await baseExpect
        .poll(() => prefetchRequests.length, { timeout: 5000 })
        .toBe(1);
    },
  );

  base(
    "should not prefetch below-fold viewport link until scrolled",
    async ({ page }) => {
      const prefetchRequests: string[] = [];
      page.on("request", (request) => {
        const url = request.url();
        if (url.includes("_rsc_partial") && url.includes("/shop")) {
          prefetchRequests.push(url);
        }
      });

      await page.goto(f.url("/prefetch-test"));
      await waitForHydration(page);

      await expectCountToRemain(baseExpect, () => prefetchRequests.length, 0);
      baseExpect(prefetchRequests.length).toBe(0);

      await page
        .locator('[data-testid="viewport-below-fold"]')
        .scrollIntoViewIfNeeded();

      await baseExpect
        .poll(() => prefetchRequests.length, { timeout: 5000 })
        .toBe(1);
    },
  );

  base("should prefetch render links on mount", async ({ page }) => {
    const prefetchRequests: string[] = [];
    page.on("request", (request) => {
      const url = request.url();
      if (url.includes("_rsc_partial") && url.includes("/about")) {
        prefetchRequests.push(url);
      }
    });

    await page.goto(f.url("/prefetch-test"));
    await waitForHydration(page);

    await baseExpect
      .poll(() => prefetchRequests.length, { timeout: 5000 })
      .toBe(1);
  });

  base("should resolve adaptive to hover on desktop", async ({ page }) => {
    const prefetchRequests: string[] = [];
    page.on("request", (request) => {
      const url = request.url();
      if (url.includes("_rsc_partial") && url.includes("/magazine")) {
        prefetchRequests.push(url);
      }
    });

    await page.goto(f.url("/prefetch-test"));
    await waitForHydration(page);

    await expectCountToRemain(baseExpect, () => prefetchRequests.length, 0);
    baseExpect(prefetchRequests.length).toBe(0);

    await page.locator('a:has-text("Magazine (adaptive)")').hover();

    await baseExpect
      .poll(() => prefetchRequests.length, { timeout: 5000 })
      .toBe(1);
  });
});
