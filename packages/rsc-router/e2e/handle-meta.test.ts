import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, testId } from "./helper";

/**
 * Meta handle tests - document metadata management across route segments
 */
test.describe("handle-meta", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });

  test.describe("default meta tags", () => {
    test("should include default charSet and viewport", async ({ page }) => {
      await page.goto(f.url("/"));
      await waitForHydration(page);

      // Check charSet meta tag
      const charSet = await page.locator('meta[charset="utf-8"]');
      await expect(charSet).toHaveCount(1);

      // Check viewport meta tag
      const viewport = await page.locator('meta[name="viewport"]');
      await expect(viewport).toHaveAttribute(
        "content",
        "width=device-width, initial-scale=1"
      );
    });

    test("should have default title on home page", async ({ page }) => {
      await page.goto(f.url("/"));
      await waitForHydration(page);

      await expect(page).toHaveTitle("RSC Router Test App");
    });

    test("should have default description on home page", async ({ page }) => {
      await page.goto(f.url("/"));
      await waitForHydration(page);

      const description = await page.locator('meta[name="description"]');
      await expect(description).toHaveAttribute(
        "content",
        "E2E test application for RSC Router"
      );
    });
  });

  test.describe("route-specific meta tags", () => {
    test("should update title on blog page", async ({ page }) => {
      await page.goto(f.url("/blog"));
      await waitForHydration(page);

      await expect(page).toHaveTitle("Blog - RSC Router Test App");
    });

    test("should update description on blog page", async ({ page }) => {
      await page.goto(f.url("/blog"));
      await waitForHydration(page);

      const description = await page.locator('meta[name="description"]');
      await expect(description).toHaveAttribute(
        "content",
        "Blog posts from RSC Router"
      );
    });

    test("should update title on blog post page", async ({ page }) => {
      await page.goto(f.url("/blog/post-1"));
      await waitForHydration(page);

      await expect(page).toHaveTitle("Post post-1 - Blog - RSC Router Test App");
    });
  });

  test.describe("streaming metadata", () => {
    test("should update title after awaiting product data", async ({ page }) => {
      await page.goto(f.url("/product/product-a"));
      await waitForHydration(page);

      // Title should be updated with product name after data loads
      await expect(page).toHaveTitle("Product A - RSC Router Test App", {
        timeout: 5000,
      });
    });

    test("should update description after awaiting product data", async ({
      page,
    }) => {
      await page.goto(f.url("/product/product-a"));
      await waitForHydration(page);

      const description = await page.locator('meta[name="description"]');
      await expect(description).toHaveAttribute(
        "content",
        "A great product",
        { timeout: 5000 }
      );
    });

    test("should include og:title after awaiting product data", async ({
      page,
    }) => {
      await page.goto(f.url("/product/product-a"));
      await waitForHydration(page);

      const ogTitle = await page.locator('meta[property="og:title"]');
      await expect(ogTitle).toHaveAttribute("content", "Product A", {
        timeout: 5000,
      });
    });
  });

  test.describe("JSON-LD structured data", () => {
    test("should render JSON-LD script for product", async ({ page }) => {
      await page.goto(f.url("/product/product-a"));
      await waitForHydration(page);

      // Wait for product data to load
      await expect(testId(page, "product-name")).toBeVisible({ timeout: 5000 });

      // Check JSON-LD script exists
      const jsonLd = await page.locator('script[type="application/ld+json"]');
      await expect(jsonLd).toHaveCount(1);

      // Verify JSON-LD content
      const jsonLdContent = await jsonLd.textContent();
      const parsed = JSON.parse(jsonLdContent!);
      expect(parsed["@context"]).toBe("https://schema.org");
      expect(parsed["@type"]).toBe("Product");
      expect(parsed.name).toBe("Product A");
      expect(parsed.offers["@type"]).toBe("Offer");
      expect(parsed.offers.priceCurrency).toBe("USD");
    });
  });

  test.describe("meta updates on navigation", () => {
    test("should update title when navigating from home to blog", async ({
      page,
    }) => {
      await page.goto(f.url("/"));
      await waitForHydration(page);

      await expect(page).toHaveTitle("RSC Router Test App");

      // Navigate to blog
      await page.goto(f.url("/blog"));
      await waitForHydration(page);

      await expect(page).toHaveTitle("Blog - RSC Router Test App");
    });

    test("should update title on soft navigation to product", async ({
      page,
    }) => {
      await page.goto(f.url("/"));
      await waitForHydration(page);

      await expect(page).toHaveTitle("RSC Router Test App");

      // Click on product link (soft navigation)
      await testId(page, "product-link-product-a").click();

      // Wait for product page and title update
      await expect(testId(page, "product-detail-page")).toBeVisible({
        timeout: 5000,
      });
      await expect(page).toHaveTitle("Product A - RSC Router Test App", {
        timeout: 5000,
      });
    });

    test("should update title on soft navigation between blog posts", async ({
      page,
    }) => {
      await page.goto(f.url("/blog"));
      await waitForHydration(page);

      await expect(page).toHaveTitle("Blog - RSC Router Test App");

      // Navigate to post-1
      await testId(page, "blog-post-link-1").click();
      await expect(testId(page, "blog-post-page")).toBeVisible({ timeout: 5000 });
      await expect(page).toHaveTitle("Post post-1 - Blog - RSC Router Test App");

      // Navigate back to blog
      await testId(page, "back-to-blog").click();
      await expect(testId(page, "blog-index-page")).toBeVisible({ timeout: 5000 });
      await expect(page).toHaveTitle("Blog - RSC Router Test App");

      // Navigate to post-2
      await testId(page, "blog-post-link-2").click();
      await expect(testId(page, "blog-post-page")).toBeVisible({ timeout: 5000 });
      await expect(page).toHaveTitle("Post post-2 - Blog - RSC Router Test App");
    });

    test("should update meta description on navigation", async ({ page }) => {
      await page.goto(f.url("/"));
      await waitForHydration(page);

      let description = page.locator('meta[name="description"]');
      await expect(description).toHaveAttribute(
        "content",
        "E2E test application for RSC Router"
      );

      // Navigate to blog
      await page.goto(f.url("/blog"));
      await waitForHydration(page);

      description = page.locator('meta[name="description"]');
      await expect(description).toHaveAttribute(
        "content",
        "Blog posts from RSC Router"
      );
    });
  });

  test.describe("no hydration mismatch", () => {
    test("should not show hydration mismatch for meta tags", async ({
      page,
    }) => {
      const hydrationErrors: string[] = [];

      page.on("console", (msg) => {
        const text = msg.text();
        if (
          text.includes("Hydration failed") ||
          text.includes("hydration mismatch") ||
          text.includes("Text content does not match")
        ) {
          hydrationErrors.push(text);
        }
      });

      // Test various pages for hydration issues
      await page.goto(f.url("/"));
      await waitForHydration(page);
      expect(hydrationErrors).toEqual([]);

      await page.goto(f.url("/blog"));
      await waitForHydration(page);
      expect(hydrationErrors).toEqual([]);

      await page.goto(f.url("/product/product-a"));
      await waitForHydration(page);
      expect(hydrationErrors).toEqual([]);
    });
  });
});
