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
});
