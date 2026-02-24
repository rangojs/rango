import { test, expect, devURL } from "./dev-fixture";
import { test as base, expect as baseExpect } from "@playwright/test";
import { waitForHydration, expectNoPageError } from "./helper";
import { useFixture } from "./fixture";

/**
 * Prefetch on hover tests - verifies that prefetch="hover" on Link components
 * injects <link rel="prefetch"> elements into <head> on mouseenter.
 * Source: packages/rangojs-router/src/browser/react/Link.tsx (prefetchUrl, handleMouseEnter)
 */
test.describe("prefetch-on-hover", () => {
  test("should inject prefetch link on hover", async ({ page, devServerURL }) => {
    using _ = expectNoPageError(page);

    await page.goto(devURL(devServerURL, "/"));
    await waitForHydration(page);

    // Verify no prefetch links exist initially for /blog
    const prefetchCountBefore = await page.evaluate(
      () =>
        document.querySelectorAll('link[rel="prefetch"][href*="/blog"]').length
    );
    expect(prefetchCountBefore).toBe(0);

    // Hover over the Blog nav link
    const blogLink = page.locator('nav a:has-text("Blog")');
    await blogLink.hover();

    // Wait for the prefetch link to appear
    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              document.querySelectorAll(
                'link[rel="prefetch"][href*="/blog"]'
              ).length
          ),
        { timeout: 3000 }
      )
      .toBeGreaterThan(0);

    // Verify the prefetch link has the RSC partial parameter
    const hasRscPartial = await page.evaluate(() => {
      const link = document.querySelector(
        'link[rel="prefetch"][href*="/blog"]'
      ) as HTMLLinkElement | null;
      return link?.href.includes("_rsc_partial") ?? false;
    });
    expect(hasRscPartial).toBe(true);
  });

  test("should not create duplicate prefetch links on repeated hover", async ({
    page,
    devServerURL,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(devURL(devServerURL, "/"));
    await waitForHydration(page);

    const blogLink = page.locator('nav a:has-text("Blog")');

    // Hover, move away, hover again
    await blogLink.hover();
    await page.waitForTimeout(200);

    // Move away from the link
    await page.locator("h1").first().hover();
    await page.waitForTimeout(200);

    // Hover again
    await blogLink.hover();
    await page.waitForTimeout(200);

    // There should be exactly one prefetch link for /blog
    const prefetchCount = await page.evaluate(
      () =>
        document.querySelectorAll('link[rel="prefetch"][href*="/blog"]').length
    );
    expect(prefetchCount).toBe(1);
  });

  test("should prefetch multiple links independently", async ({ page, devServerURL }) => {
    using _ = expectNoPageError(page);

    await page.goto(devURL(devServerURL, "/"));
    await waitForHydration(page);

    // Hover over Blog link
    await page.locator('nav a:has-text("Blog")').hover();
    await page.waitForTimeout(200);

    // Hover over Shop link
    await page.locator('nav a:has-text("Shop")').hover();
    await page.waitForTimeout(200);

    // Both prefetch links should exist
    const blogPrefetch = await page.evaluate(
      () =>
        document.querySelectorAll('link[rel="prefetch"][href*="/blog"]').length
    );
    const shopPrefetch = await page.evaluate(
      () =>
        document.querySelectorAll('link[rel="prefetch"][href*="/shop"]').length
    );

    expect(blogPrefetch).toBe(1);
    expect(shopPrefetch).toBe(1);
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
});

/**
 * Prefetch content negotiation (production)
 */
base.describe("prefetch-content-negotiation (production)", () => {
  const f = useFixture({
    root: ".",
    mode: "build",
  });

  base.setTimeout(120000);

  base("should return RSC Flight for partial request with Accept: text/html", async () => {
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
  });
});
