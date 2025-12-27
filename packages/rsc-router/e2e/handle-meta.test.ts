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
        "First test product",
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

  test.describe("async meta descriptors", () => {
    test("should stream async meta descriptor (Promise)", async ({ page }) => {
      await page.goto(f.url("/blog/post-1"));
      await waitForHydration(page);

      // The og:description is pushed as a Promise that resolves after 500ms
      // It should stream in and be present in the DOM
      const ogDescription = page.locator('meta[property="og:description"]');
      await expect(ogDescription).toHaveAttribute(
        "content",
        "Async meta for post-1",
        { timeout: 3000 }
      );
    });

    test("should update async meta on navigation", async ({ page }) => {
      await page.goto(f.url("/blog/post-1"));
      await waitForHydration(page);

      // Wait for async meta to stream in
      let ogDescription = page.locator('meta[property="og:description"]');
      await expect(ogDescription).toHaveAttribute(
        "content",
        "Async meta for post-1",
        { timeout: 3000 }
      );

      // Navigate to post-2
      await testId(page, "back-to-blog").click();
      await expect(testId(page, "blog-index-page")).toBeVisible({ timeout: 5000 });

      await testId(page, "blog-post-link-2").click();
      await expect(testId(page, "blog-post-page")).toBeVisible({ timeout: 5000 });

      // Async meta should update for post-2
      ogDescription = page.locator('meta[property="og:description"]');
      await expect(ogDescription).toHaveAttribute(
        "content",
        "Async meta for post-2",
        { timeout: 3000 }
      );
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

      // Click on product link (opens modal/intercept first)
      await testId(page, "product-link-product-a").click();

      // Wait for modal to appear
      await expect(testId(page, "product-modal")).toBeVisible({
        timeout: 5000,
      });

      // Click "View Full Details" to navigate to actual product page
      await testId(page, "view-full-details").click();

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

  test.describe("SSR meta tags (no JavaScript)", () => {
    const htmlHeaders = {
      Accept: "text/html,application/xhtml+xml",
    };

    test("should include charset and viewport in initial HTML", async ({
      request,
    }) => {
      const response = await request.get(f.url("/"), { headers: htmlHeaders });
      const html = await response.text();

      expect(html).toContain('<meta charSet="utf-8"');
      expect(html).toContain('<meta name="viewport"');
      expect(html).toContain("width=device-width, initial-scale=1");
    });

    test("should include title in initial HTML", async ({ request }) => {
      const response = await request.get(f.url("/"), { headers: htmlHeaders });
      const html = await response.text();

      expect(html).toContain("<title>RSC Router Test App</title>");
    });

    test("should include description in initial HTML", async ({ request }) => {
      const response = await request.get(f.url("/"), { headers: htmlHeaders });
      const html = await response.text();

      expect(html).toContain('<meta name="description"');
      expect(html).toContain("E2E test application for RSC Router");
    });

    test("should include route-specific title in initial HTML", async ({
      request,
    }) => {
      const response = await request.get(f.url("/blog"), {
        headers: htmlHeaders,
      });
      const html = await response.text();

      expect(html).toContain("<title>Blog - RSC Router Test App</title>");
    });

    test("should include route-specific description in initial HTML", async ({
      request,
    }) => {
      const response = await request.get(f.url("/blog"), {
        headers: htmlHeaders,
      });
      const html = await response.text();

      expect(html).toContain('<meta name="description"');
      expect(html).toContain("Blog posts from RSC Router");
    });

    test("should include dynamic route meta in initial HTML", async ({
      request,
    }) => {
      const response = await request.get(f.url("/blog/post-1"), {
        headers: htmlHeaders,
      });
      const html = await response.text();

      expect(html).toContain(
        "<title>Post post-1 - Blog - RSC Router Test App</title>"
      );
      expect(html).toContain("Content for post post-1");
    });

    test("should include awaited async meta in initial HTML (product page)", async ({
      request,
    }) => {
      // Product page sets meta after awaiting ProductDetailLoader
      const response = await request.get(f.url("/product/product-a"), {
        headers: htmlHeaders,
      });
      const html = await response.text();

      // Title and description are set after awaiting loader data
      expect(html).toContain(
        "<title>Product A - RSC Router Test App</title>"
      );
      expect(html).toContain("First test product");
      expect(html).toContain('property="og:title"');
      expect(html).toContain("Product A");
    });

    test("should include JSON-LD structured data in initial HTML", async ({
      request,
    }) => {
      const response = await request.get(f.url("/product/product-a"), {
        headers: htmlHeaders,
      });
      const html = await response.text();

      // JSON-LD should be in initial HTML for SEO crawlers
      expect(html).toContain('type="application/ld+json"');
      expect(html).toContain("https://schema.org");
      expect(html).toContain('"@type":"Product"');
    });
  });

  test.describe("handle passthrough to child RSC", () => {
    test("should set meta from child RSC component", async ({ page }) => {
      await page.goto(f.url("/handle-passthrough"));
      await waitForHydration(page);

      // Title and description should be set by child component
      await expect(page).toHaveTitle("Child Set Title - RSC Router");

      const description = page.locator('meta[name="description"]');
      await expect(description).toHaveAttribute(
        "content",
        "Meta set by child RSC component"
      );

      const ogTitle = page.locator('meta[property="og:title"]');
      await expect(ogTitle).toHaveAttribute(
        "content",
        "Child Set Title - RSC Router"
      );
    });

    test("should include child-set meta in initial HTML (SSR)", async ({
      request,
    }) => {
      const response = await request.get(f.url("/handle-passthrough"), {
        headers: { Accept: "text/html,application/xhtml+xml" },
      });
      const html = await response.text();

      // Meta set by child RSC should be in initial HTML
      expect(html).toContain("<title>Child Set Title - RSC Router</title>");
      expect(html).toContain("Meta set by child RSC component");
      expect(html).toContain('property="og:title"');
    });

    test("should render child component content", async ({ page }) => {
      await page.goto(f.url("/handle-passthrough"));
      await waitForHydration(page);

      await expect(testId(page, "child-meta-setter")).toBeVisible();
      await expect(testId(page, "child-set-title")).toContainText(
        "Set title: Child Set Title - RSC Router"
      );
      await expect(testId(page, "child-set-description")).toContainText(
        "Set description: Meta set by child RSC component"
      );
    });
  });

  test.describe("async handle passthrough (delayed meta) - known limitation", () => {
    /**
     * KNOWN LIMITATION: Meta set from async children with loading fallbacks
     * will NOT be included in the initial SSR response or update the DOM.
     *
     * This is because:
     * 1. Handle values are collected when ctx.use(Handle) is called
     * 2. For async children wrapped in Suspense, the parent renders immediately
     * 3. The async child's meta() calls happen AFTER handles are collected
     *
     * Workaround: Set meta in the parent component before rendering async children,
     * or use a loader to fetch data and set meta before the route handler returns.
     */

    test("async child content should render after delay", async ({ page }) => {
      await page.goto(f.url("/handle-passthrough-async"));
      await waitForHydration(page);

      // Wait for loading state to disappear first
      await expect(testId(page, "async-passthrough-loading")).toBeHidden({
        timeout: 10000,
      });

      // Then wait for async child content (2s delay in component)
      await expect(testId(page, "async-child-meta-setter")).toBeVisible({
        timeout: 5000,
      });

      // Child content is rendered
      await expect(testId(page, "async-child-set-title")).toContainText(
        "Async Child Title - RSC Router"
      );
    });

    test("meta from async child should NOT be in SSR response (known limitation)", async ({
      request,
    }) => {
      const response = await request.get(f.url("/handle-passthrough-async"), {
        headers: { Accept: "text/html,application/xhtml+xml" },
      });
      const html = await response.text();

      // The initial <title> is from root layout, NOT the async child
      expect(html).toContain("<title>RSC Router Test App</title>");

      // The async child's meta is NOT in the <head>
      expect(html).not.toContain("<title>Async Child Title");

      // But the async child's CONTENT is streamed (just not the meta)
      expect(html).toContain("async-child-meta-setter");
    });

    test("meta should remain from parent (async child meta not applied)", async ({
      page,
    }) => {
      await page.goto(f.url("/handle-passthrough-async"));
      await waitForHydration(page);

      // Wait for loading state to disappear first
      await expect(testId(page, "async-passthrough-loading")).toBeHidden({
        timeout: 10000,
      });

      // Then wait for async child content
      await expect(testId(page, "async-child-meta-setter")).toBeVisible({
        timeout: 5000,
      });

      // Title remains the root layout default (async child's meta not applied)
      await expect(page).toHaveTitle("RSC Router Test App");
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

  test.describe("title templates", () => {
    test("should use default title when no child title is set", async ({ page }) => {
      await page.goto(f.url("/meta-template"));
      await waitForHydration(page);

      // Index route uses the default from template
      await expect(page).toHaveTitle("Test Site");
    });

    test("should apply template to child route title", async ({ page }) => {
      await page.goto(f.url("/meta-template/child"));
      await waitForHydration(page);

      // Child sets title: "Child Page", template is "%s | Test Site"
      await expect(page).toHaveTitle("Child Page | Test Site");
    });

    test("should bypass template with absolute title", async ({ page }) => {
      await page.goto(f.url("/meta-template/absolute"));
      await waitForHydration(page);

      // Absolute title should bypass template completely
      await expect(page).toHaveTitle("Custom Absolute Title");
    });

    test("should use nested template instead of parent template", async ({ page }) => {
      await page.goto(f.url("/meta-template/nested"));
      await waitForHydration(page);

      // Nested layout sets new template with default "Nested Section"
      await expect(page).toHaveTitle("Nested Section");
    });

    test("should apply nested template to nested child", async ({ page }) => {
      await page.goto(f.url("/meta-template/nested/child"));
      await waitForHydration(page);

      // Nested child sets "Nested Child", nested template is "%s | Nested Section"
      await expect(page).toHaveTitle("Nested Child | Nested Section");
    });

    test("template should work with SSR (initial HTML)", async ({ request }) => {
      const response = await request.get(f.url("/meta-template/child"), {
        headers: { Accept: "text/html,application/xhtml+xml" },
      });
      const html = await response.text();

      expect(html).toContain("<title>Child Page | Test Site</title>");
    });

    test("absolute title should work with SSR", async ({ request }) => {
      const response = await request.get(f.url("/meta-template/absolute"), {
        headers: { Accept: "text/html,application/xhtml+xml" },
      });
      const html = await response.text();

      expect(html).toContain("<title>Custom Absolute Title</title>");
    });

    test("should update title on soft navigation with template", async ({ page }) => {
      await page.goto(f.url("/meta-template"));
      await waitForHydration(page);

      await expect(page).toHaveTitle("Test Site");

      // Navigate to child
      await testId(page, "meta-template-child-link").click();
      await expect(testId(page, "meta-template-child-page")).toBeVisible({ timeout: 5000 });
      await expect(page).toHaveTitle("Child Page | Test Site");

      // Navigate to absolute
      await testId(page, "meta-template-absolute-link").click();
      await expect(testId(page, "meta-template-absolute-page")).toBeVisible({ timeout: 5000 });
      await expect(page).toHaveTitle("Custom Absolute Title");
    });
  });

  test.describe("meta unset", () => {
    test("should inherit all parent meta on index route", async ({ page }) => {
      await page.goto(f.url("/meta-unset"));
      await waitForHydration(page);

      await expect(page).toHaveTitle("Parent Title");

      const robots = page.locator('meta[name="robots"]');
      await expect(robots).toHaveAttribute("content", "index, follow");

      const description = page.locator('meta[name="description"]');
      await expect(description).toHaveAttribute("content", "Parent description");

      const ogImage = page.locator('meta[property="og:image"]');
      await expect(ogImage).toHaveAttribute("content", "https://example.com/parent.jpg");
    });

    test("should unset specific meta tags", async ({ page }) => {
      await page.goto(f.url("/meta-unset/child"));
      await waitForHydration(page);

      // Title and description should still be present (not unset)
      await expect(page).toHaveTitle("Parent Title");

      const description = page.locator('meta[name="description"]');
      await expect(description).toHaveAttribute("content", "Parent description");

      // robots and og:image should be removed
      const robots = page.locator('meta[name="robots"]');
      await expect(robots).toHaveCount(0);

      const ogImage = page.locator('meta[property="og:image"]');
      await expect(ogImage).toHaveCount(0);
    });

    test("should unset then set new value", async ({ page }) => {
      await page.goto(f.url("/meta-unset/unset-then-set"));
      await waitForHydration(page);

      // Title should be the new value after unset + set
      await expect(page).toHaveTitle("New Title After Unset");

      // Description should be the new value after unset + set
      const description = page.locator('meta[name="description"]');
      await expect(description).toHaveAttribute("content", "New description after unset");

      // robots should still be present (not unset in this route)
      const robots = page.locator('meta[name="robots"]');
      await expect(robots).toHaveAttribute("content", "index, follow");
    });

    test("unset should work with SSR", async ({ request }) => {
      const response = await request.get(f.url("/meta-unset/child"), {
        headers: { Accept: "text/html,application/xhtml+xml" },
      });
      const html = await response.text();

      // Title and description should be present
      expect(html).toContain("<title>Parent Title</title>");
      expect(html).toContain("Parent description");

      // robots and og:image should NOT be present
      expect(html).not.toContain('name="robots"');
      expect(html).not.toContain('property="og:image"');
    });

    test("should update meta on soft navigation with unset", async ({ page }) => {
      await page.goto(f.url("/meta-unset"));
      await waitForHydration(page);

      // Verify robots exists on index
      const robotsOnIndex = page.locator('meta[name="robots"]');
      await expect(robotsOnIndex).toHaveCount(1);

      // Navigate to child that unsets robots
      await testId(page, "meta-unset-child-link").click();
      await expect(testId(page, "meta-unset-child-page")).toBeVisible({ timeout: 5000 });

      // robots should be gone
      const robotsOnChild = page.locator('meta[name="robots"]');
      await expect(robotsOnChild).toHaveCount(0);

      // Navigate back to index
      await testId(page, "meta-unset-index-link").click();
      await expect(testId(page, "meta-unset-index-page")).toBeVisible({ timeout: 5000 });

      // robots should be back
      const robotsBack = page.locator('meta[name="robots"]');
      await expect(robotsBack).toHaveCount(1);
    });
  });

  test.describe("meta merging behavior", () => {
    test("child should override parent meta with same key", async ({ page }) => {
      await page.goto(f.url("/meta-merge/child"));
      await waitForHydration(page);

      // Title overridden by child
      await expect(page).toHaveTitle("Merge Child");

      // keywords overridden by child
      const keywords = page.locator('meta[name="keywords"]');
      await expect(keywords).toHaveAttribute("content", "child, override");
    });

    test("child should inherit parent meta for different keys", async ({ page }) => {
      await page.goto(f.url("/meta-merge/child"));
      await waitForHydration(page);

      // author inherited from parent (not set by child)
      const author = page.locator('meta[name="author"]');
      await expect(author).toHaveAttribute("content", "Root Author");

      // og:site_name inherited from parent
      const ogSiteName = page.locator('meta[property="og:site_name"]');
      await expect(ogSiteName).toHaveAttribute("content", "Merge Test Site");
    });

    test("child should add new meta not in parent", async ({ page }) => {
      await page.goto(f.url("/meta-merge/child"));
      await waitForHydration(page);

      // description added by child (not in parent)
      const description = page.locator('meta[name="description"]');
      await expect(description).toHaveAttribute("content", "Child description");
    });

    test("deeply nested routes should merge correctly", async ({ page }) => {
      await page.goto(f.url("/meta-merge/deep/nested"));
      await waitForHydration(page);

      // Title from deep page
      await expect(page).toHaveTitle("Deep Nested Page");

      // keywords from root (not overridden by middle or deep)
      const keywords = page.locator('meta[name="keywords"]');
      await expect(keywords).toHaveAttribute("content", "root, test");

      // author from middle layout (overrides root)
      const author = page.locator('meta[name="author"]');
      await expect(author).toHaveAttribute("content", "Middle Author");

      // og:site_name from root (not overridden)
      const ogSiteName = page.locator('meta[property="og:site_name"]');
      await expect(ogSiteName).toHaveAttribute("content", "Merge Test Site");

      // og:title from deep page (newly added)
      const ogTitle = page.locator('meta[property="og:title"]');
      await expect(ogTitle).toHaveAttribute("content", "Deep OG Title");
    });

    test("merging should work with SSR", async ({ request }) => {
      const response = await request.get(f.url("/meta-merge/deep/nested"), {
        headers: { Accept: "text/html,application/xhtml+xml" },
      });
      const html = await response.text();

      // Deep page title
      expect(html).toContain("<title>Deep Nested Page</title>");

      // Root keywords
      expect(html).toContain("root, test");

      // Middle author
      expect(html).toContain("Middle Author");

      // Root og:site_name
      expect(html).toContain("Merge Test Site");

      // Deep og:title
      expect(html).toContain("Deep OG Title");
    });

    test("index should have all root meta", async ({ page }) => {
      await page.goto(f.url("/meta-merge"));
      await waitForHydration(page);

      await expect(page).toHaveTitle("Merge Root");

      const author = page.locator('meta[name="author"]');
      await expect(author).toHaveAttribute("content", "Root Author");

      const keywords = page.locator('meta[name="keywords"]');
      await expect(keywords).toHaveAttribute("content", "root, test");

      const ogSiteName = page.locator('meta[property="og:site_name"]');
      await expect(ogSiteName).toHaveAttribute("content", "Merge Test Site");
    });
  });
});
