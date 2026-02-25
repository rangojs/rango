import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError } from "./helper";

/**
 * Tests for route resolution and mounting:
 * 1. Routes resolve correctly without trailing slash
 * 2. Routes resolve correctly with trailing slash (known bug)
 * 3. Nested routes resolve correctly
 * 4. Dynamic segments resolve correctly
 */

test.describe("route-resolution", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });

  test.describe("basic-routes", () => {
    test("index route should resolve at /", async ({ page }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/"));
      await waitForHydration(page);

      await expect(page.locator('[data-testid="index-page"]')).toBeVisible();
      await expect(page.locator('[data-testid="page-title"]')).toContainText(
        "Products",
      );
    });

    test("blog index should resolve at /blog", async ({ page }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/blog"));
      await waitForHydration(page);

      await expect(
        page.locator('[data-testid="blog-index-page"]'),
      ).toBeVisible();
      await expect(page.locator('[data-testid="blog-title"]')).toContainText(
        "Blog",
      );
    });
  });

  test.describe("trailing-slash", () => {
    // Trailing slash handling: routes with trailing slash redirect to without (trailingSlash: "never" default)

    test("blog index should resolve at /blog/ (with trailing slash)", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/blog/"));
      await waitForHydration(page);

      // Should render the same as /blog
      await expect(
        page.locator('[data-testid="blog-index-page"]'),
      ).toBeVisible();
      await expect(page.locator('[data-testid="blog-title"]')).toContainText(
        "Blog",
      );
    });

    test("index should resolve at / (root with implicit trailing slash)", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/"));
      await waitForHydration(page);

      await expect(page.locator('[data-testid="index-page"]')).toBeVisible();
    });

    test("product detail should resolve with trailing slash", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      // /product/product-a/ should work the same as /product/product-a
      await page.goto(f.url("/product/product-a/"));
      await waitForHydration(page);

      await expect(
        page.locator('[data-testid="product-detail-page"]'),
      ).toBeVisible();
      await expect(page.locator('[data-testid="product-name"]')).toContainText(
        "Product A",
      );
    });
  });

  test.describe("trailing-slash-config", () => {
    // Tests for per-route trailing slash configuration

    test("trailingSlash: ignore - should match /ts-ignore without redirect", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/ts-ignore"));
      await waitForHydration(page);

      await expect(
        page.locator('[data-testid="ts-ignore-page"]'),
      ).toBeVisible();
      await expect(
        page.locator('[data-testid="ts-ignore-title"]'),
      ).toContainText("Trailing Slash: Ignore");
    });

    test("trailingSlash: ignore - should match /ts-ignore/ without redirect", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/ts-ignore/"));
      await waitForHydration(page);

      await expect(
        page.locator('[data-testid="ts-ignore-page"]'),
      ).toBeVisible();
      await expect(
        page.locator('[data-testid="ts-ignore-title"]'),
      ).toContainText("Trailing Slash: Ignore");
    });

    test("trailingSlash: always - should redirect /ts-always to /ts-always/", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      // Navigate to /ts-always (without trailing slash)
      const response = await page.goto(f.url("/ts-always"));
      await waitForHydration(page);

      // Should redirect to /ts-always/ and render the page
      expect(page.url()).toContain("/ts-always/");
      await expect(
        page.locator('[data-testid="ts-always-page"]'),
      ).toBeVisible();
    });

    test("trailingSlash: always - should match /ts-always/ directly", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/ts-always/"));
      await waitForHydration(page);

      await expect(
        page.locator('[data-testid="ts-always-page"]'),
      ).toBeVisible();
    });

    test("trailingSlash: never - should redirect /ts-never/ to /ts-never", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      // Navigate to /ts-never/ (with trailing slash)
      await page.goto(f.url("/ts-never/"));
      await waitForHydration(page);

      // Should redirect to /ts-never and render the page
      expect(page.url()).not.toContain("/ts-never/");
      expect(page.url()).toContain("/ts-never");
      await expect(page.locator('[data-testid="ts-never-page"]')).toBeVisible();
    });

    test("trailingSlash: never - should match /ts-never directly", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/ts-never"));
      await waitForHydration(page);

      await expect(page.locator('[data-testid="ts-never-page"]')).toBeVisible();
    });
  });

  test.describe("nested-routes", () => {
    test("blog post should resolve at /blog/:postId", async ({ page }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/blog/my-first-post"));
      await waitForHydration(page);

      await expect(
        page.locator('[data-testid="blog-post-page"]'),
      ).toBeVisible();
      await expect(
        page.locator('[data-testid="blog-post-title"]'),
      ).toContainText("Post: my-first-post");
    });

    test("blog post should resolve with trailing slash", async ({ page }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/blog/my-first-post/"));
      await waitForHydration(page);

      await expect(
        page.locator('[data-testid="blog-post-page"]'),
      ).toBeVisible();
      await expect(
        page.locator('[data-testid="blog-post-title"]'),
      ).toContainText("Post: my-first-post");
    });
  });

  test.describe("dynamic-segments", () => {
    test("product detail should resolve dynamic :productId", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/product/product-a"));
      await waitForHydration(page);

      await expect(
        page.locator('[data-testid="product-detail-page"]'),
      ).toBeVisible();
      await expect(page.locator('[data-testid="product-name"]')).toContainText(
        "Product A",
      );
    });

    test("product detail should handle different product IDs", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      // Test product-b
      await page.goto(f.url("/product/product-b"));
      await waitForHydration(page);

      await expect(page.locator('[data-testid="product-name"]')).toContainText(
        "Product B",
      );

      // Test product-c
      await page.goto(f.url("/product/product-c"));
      await waitForHydration(page);

      await expect(page.locator('[data-testid="product-name"]')).toContainText(
        "Product C",
      );
    });

    test("blog post should handle various postId values", async ({ page }) => {
      using _ = expectNoPageError(page);

      // Numeric ID
      await page.goto(f.url("/blog/123"));
      await waitForHydration(page);
      await expect(
        page.locator('[data-testid="blog-post-title"]'),
      ).toContainText("Post: 123");

      // Slug with hyphens
      await page.goto(f.url("/blog/my-awesome-post"));
      await waitForHydration(page);
      await expect(
        page.locator('[data-testid="blog-post-title"]'),
      ).toContainText("Post: my-awesome-post");
    });
  });

  test.describe("spa-navigation", () => {
    test("SPA navigation should work from blog index to post", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/blog"));
      await waitForHydration(page);

      // Click on a post link
      await page.locator('[data-testid="blog-post-link-1"]').click();

      await expect(
        page.locator('[data-testid="blog-post-page"]'),
      ).toBeVisible();
      await expect(
        page.locator('[data-testid="blog-post-title"]'),
      ).toContainText("Post: post-1");
    });

    test("SPA navigation should work from post back to blog index", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/blog/post-1"));
      await waitForHydration(page);

      // Click back to blog
      await page.locator('[data-testid="back-to-blog"]').click();

      await expect(
        page.locator('[data-testid="blog-index-page"]'),
      ).toBeVisible();
    });
  });
});
