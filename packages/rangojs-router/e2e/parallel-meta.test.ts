import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError } from "./helper";

/**
 * @meta and @breadcrumbs parallel slot pattern tests.
 * Validates that parallel slots can set handles and that:
 * - Layout title template defaults apply on index
 * - @meta parallel overrides title per route
 * - @meta parallel can add JSON-LD
 * - @breadcrumbs parallel adds breadcrumb items per route
 * - Soft navigation updates meta and breadcrumbs from parallel slots
 * - Handles from parallel slots are removed on navigation away
 * - SSR includes meta and breadcrumbs from parallel slots
 */

// ============================================================================
// Dev
// ============================================================================

test.describe("parallel-meta-slot", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });

  test("index page should use layout defaults (title + breadcrumb)", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/parallel-meta"));
    await waitForHydration(page);

    await expect(page.getByTestId("pm-index-page")).toBeVisible();
    await expect(page).toHaveTitle("Test Store");

    const description = page.locator('meta[name="description"]');
    await expect(description).toHaveAttribute(
      "content",
      "Default store description",
    );

    // Only the layout breadcrumb ("Store") — no @breadcrumbs slot on index
    await expect(page.getByTestId("breadcrumbs-current")).toHaveText("Store");
  });

  test("product page should have title and breadcrumbs from parallel slots", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/parallel-meta/product-a"));
    await waitForHydration(page);

    await expect(page.getByTestId("pm-product-page")).toBeVisible();
    await expect(page).toHaveTitle("Product A | Test Store");

    const description = page.locator('meta[name="description"]');
    await expect(description).toHaveAttribute(
      "content",
      "Details for Product A",
    );

    // Breadcrumbs: Store (link) / Product A (current)
    await expect(page.getByTestId("breadcrumbs-link-store")).toBeVisible();
    await expect(page.getByTestId("breadcrumbs-current")).toHaveText(
      "Product A",
    );
  });

  test("product page should have JSON-LD from @meta parallel", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/parallel-meta/product-a"));
    await waitForHydration(page);

    // WebSite (root layout) + Product (@meta parallel)
    const jsonLd = page.locator('script[type="application/ld+json"]');
    await expect(jsonLd).toHaveCount(2);
    const scripts = await jsonLd.allTextContents();
    const types = scripts.map((s) => JSON.parse(s)["@type"]);
    expect(types).toContain("WebSite");
    expect(types).toContain("Product");

    const product = scripts
      .map((s) => JSON.parse(s))
      .find((p: any) => p["@type"] === "Product");
    expect(product["@context"]).toBe("https://schema.org");
    expect(product.name).toBe("Product A");
  });

  test("soft nav from index to product should update meta", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/parallel-meta"));
    await waitForHydration(page);
    await expect(page).toHaveTitle("Test Store");

    // Soft-nav to product-a
    await page.getByTestId("pm-link-a").click();
    await expect(page.getByTestId("pm-product-page")).toBeVisible();
    await expect(page).toHaveTitle("Product A | Test Store");

    // WebSite (root layout) + Product (@meta parallel)
    const jsonLd = page.locator('script[type="application/ld+json"]');
    await expect(jsonLd).toHaveCount(2);
  });

  test("soft nav between products should update meta and breadcrumbs", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/parallel-meta/product-a"));
    await waitForHydration(page);
    await expect(page).toHaveTitle("Product A | Test Store");
    await expect(page.getByTestId("breadcrumbs-current")).toHaveText(
      "Product A",
    );

    // Soft-nav to product-b
    await page.getByTestId("pm-link-b").click();
    await expect(page.getByTestId("pm-product-name")).toContainText(
      "product-b",
    );
    await expect(page).toHaveTitle("Product B | Test Store");
    await expect(page.getByTestId("breadcrumbs-current")).toHaveText(
      "Product B",
    );

    // "Product A" must be fully removed — no stale trail
    const breadcrumbNav = page.locator('[data-testid="breadcrumbs"]');
    await expect(breadcrumbNav).not.toContainText("Product A");
    // Exact trail: Home / Store / Product B (3 items)
    const items = breadcrumbNav.locator("li");
    await expect(items).toHaveCount(3);
  });

  test("soft nav back to index should restore defaults", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/parallel-meta/product-a"));
    await waitForHydration(page);
    await expect(page).toHaveTitle("Product A | Test Store");
    await expect(page.getByTestId("breadcrumbs-current")).toHaveText(
      "Product A",
    );

    // Soft-nav to index
    await page.getByTestId("pm-link-index").click();
    await expect(page.getByTestId("pm-index-page")).toBeVisible();
    await expect(page).toHaveTitle("Test Store");

    // Product JSON-LD should be gone, only WebSite remains
    const jsonLd = page.locator('script[type="application/ld+json"]');
    await expect(jsonLd).toHaveCount(1);
    const parsed = JSON.parse((await jsonLd.textContent())!);
    expect(parsed["@type"]).toBe("WebSite");

    // Breadcrumb should show only layout's "Store" (no product breadcrumb)
    await expect(page.getByTestId("breadcrumbs-current")).toHaveText("Store");
  });

  test("soft nav between products should update JSON-LD content", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/parallel-meta/product-a"));
    await waitForHydration(page);

    // Verify Product A JSON-LD
    let jsonLd = page.locator('script[type="application/ld+json"]');
    await expect(jsonLd).toHaveCount(2);
    let scripts = await jsonLd.allTextContents();
    let product = scripts
      .map((s) => JSON.parse(s))
      .find((p: any) => p["@type"] === "Product");
    expect(product.name).toBe("Product A");

    // Navigate to Product B
    await page.getByTestId("pm-link-b").click();
    await expect(page.getByTestId("pm-product-name")).toContainText(
      "product-b",
    );

    // JSON-LD should update to Product B
    jsonLd = page.locator('script[type="application/ld+json"]');
    await expect(jsonLd).toHaveCount(2);
    // A fully-prefetched adoption (default-on viewport prefetch of pm-link-b)
    // commits the route content immediately while the @meta slot commit can
    // trail by a frame — poll for convergence instead of a one-shot read.
    await expect
      .poll(async () => {
        const texts = await jsonLd.allTextContents();
        return texts
          .map((s) => JSON.parse(s))
          .find((p: any) => p["@type"] === "Product")?.name;
      })
      .toBe("Product B");
  });

  test("SSR should include meta from @meta parallel", async ({ request }) => {
    const response = await request.get(f.url("/parallel-meta/product-a"), {
      headers: { Accept: "text/html,application/xhtml+xml" },
    });
    const html = await response.text();

    expect(html).toContain("<title>Product A | Test Store</title>");
    expect(html).toContain("Details for Product A");
    expect(html).toContain('type="application/ld+json"');
    expect(html).toContain('"@type":"Product"');
  });

  test("SSR should include breadcrumbs from @breadcrumbs parallel", async ({
    request,
  }) => {
    const response = await request.get(f.url("/parallel-meta/product-a"), {
      headers: { Accept: "text/html,application/xhtml+xml" },
    });
    const html = await response.text();

    // Breadcrumb trail should be in SSR HTML: Home / Store / Product A
    expect(html).toContain('aria-label="Breadcrumb"');
    expect(html).toContain("Store");
    expect(html).toContain("Product A");
  });
});

// ============================================================================
// Cache regression: null-component parallels must not block cache writes
// ============================================================================

test.describe("parallel-meta-cache-regression", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });

  test("route with @meta parallel (returns null) should be cacheable", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // First visit — cache miss, segments resolved fresh
    await page.goto(f.url("/parallel-meta/product-a"));
    await waitForHydration(page);
    await expect(page).toHaveTitle("Product A | Test Store");
    const firstTs = await page.getByTestId("pm-render-ts").textContent();

    // Wait for background cache write to complete
    await page.waitForTimeout(500);

    // Second visit — should be cache hit (segments served from cache).
    // If null-component @meta parallel blocks the cache write, the handler
    // re-executes and produces a DIFFERENT timestamp (the bug).
    await page.goto(f.url("/parallel-meta/product-a"));
    await waitForHydration(page);
    const secondTs = await page.getByTestId("pm-render-ts").textContent();

    // Same timestamp = served from cache. Different = cache write failed.
    expect(secondTs).toBe(firstTs);
    await expect(page).toHaveTitle("Product A | Test Store");
  });
});

// ============================================================================
// Production
// ============================================================================

test.describe("parallel-meta-slot (production)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "build",
  });

  test("index page should use layout defaults (title + breadcrumb)", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/parallel-meta"));
    await waitForHydration(page);

    await expect(page.getByTestId("pm-index-page")).toBeVisible();
    await expect(page).toHaveTitle("Test Store");
    await expect(page.getByTestId("breadcrumbs-current")).toHaveText("Store");
  });

  test("product page should have title and breadcrumbs from parallel slots", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/parallel-meta/product-a"));
    await waitForHydration(page);

    await expect(page).toHaveTitle("Product A | Test Store");

    const description = page.locator('meta[name="description"]');
    await expect(description).toHaveAttribute(
      "content",
      "Details for Product A",
    );

    await expect(page.getByTestId("breadcrumbs-link-store")).toBeVisible();
    await expect(page.getByTestId("breadcrumbs-current")).toHaveText(
      "Product A",
    );
  });

  test("product page should have JSON-LD from @meta parallel", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/parallel-meta/product-b"));
    await waitForHydration(page);

    // WebSite (root layout) + Product (@meta parallel)
    const jsonLd = page.locator('script[type="application/ld+json"]');
    await expect(jsonLd).toHaveCount(2);
    const scripts = await jsonLd.allTextContents();
    const types = scripts.map((s) => JSON.parse(s)["@type"]);
    expect(types).toContain("WebSite");
    expect(types).toContain("Product");

    const product = scripts
      .map((s) => JSON.parse(s))
      .find((p: any) => p["@type"] === "Product");
    expect(product.name).toBe("Product B");
  });

  test("soft nav between products should update meta and breadcrumbs", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/parallel-meta/product-a"));
    await waitForHydration(page);
    await expect(page).toHaveTitle("Product A | Test Store");
    await expect(page.getByTestId("breadcrumbs-current")).toHaveText(
      "Product A",
    );

    await page.getByTestId("pm-link-b").click();
    await expect(page.getByTestId("pm-product-name")).toContainText(
      "product-b",
    );
    await expect(page).toHaveTitle("Product B | Test Store");
    await expect(page.getByTestId("breadcrumbs-current")).toHaveText(
      "Product B",
    );

    // "Product A" must be fully removed — no stale trail
    const breadcrumbNav = page.locator('[data-testid="breadcrumbs"]');
    await expect(breadcrumbNav).not.toContainText("Product A");
    // Exact trail: Home / Store / Product B (3 items)
    const items = breadcrumbNav.locator("li");
    await expect(items).toHaveCount(3);
  });

  test("soft nav back to index should restore defaults", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/parallel-meta/product-a"));
    await waitForHydration(page);
    await expect(page).toHaveTitle("Product A | Test Store");

    await page.getByTestId("pm-link-index").click();
    await expect(page.getByTestId("pm-index-page")).toBeVisible();
    await expect(page).toHaveTitle("Test Store");

    // Product JSON-LD should be gone, only WebSite remains
    const jsonLd = page.locator('script[type="application/ld+json"]');
    await expect(jsonLd).toHaveCount(1);
    const parsed = JSON.parse((await jsonLd.textContent())!);
    expect(parsed["@type"]).toBe("WebSite");

    await expect(page.getByTestId("breadcrumbs-current")).toHaveText("Store");
  });

  test("soft nav between products should update JSON-LD content", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/parallel-meta/product-a"));
    await waitForHydration(page);

    let jsonLd = page.locator('script[type="application/ld+json"]');
    await expect(jsonLd).toHaveCount(2);
    let scripts = await jsonLd.allTextContents();
    let product = scripts
      .map((s) => JSON.parse(s))
      .find((p: any) => p["@type"] === "Product");
    expect(product.name).toBe("Product A");

    await page.getByTestId("pm-link-b").click();
    await expect(page.getByTestId("pm-product-name")).toContainText(
      "product-b",
    );

    jsonLd = page.locator('script[type="application/ld+json"]');
    await expect(jsonLd).toHaveCount(2);
    // A fully-prefetched adoption (default-on viewport prefetch of pm-link-b)
    // commits the route content immediately while the @meta slot commit can
    // trail by a frame — poll for convergence instead of a one-shot read.
    await expect
      .poll(async () => {
        const texts = await jsonLd.allTextContents();
        return texts
          .map((s) => JSON.parse(s))
          .find((p: any) => p["@type"] === "Product")?.name;
      })
      .toBe("Product B");
  });

  test("SSR should include meta from @meta parallel", async ({ request }) => {
    const response = await request.get(f.url("/parallel-meta/product-a"), {
      headers: { Accept: "text/html,application/xhtml+xml" },
    });
    const html = await response.text();

    expect(html).toContain("<title>Product A | Test Store</title>");
    expect(html).toContain("Details for Product A");
    expect(html).toContain('type="application/ld+json"');
    expect(html).toContain('"@type":"Product"');
    expect(html).toContain('"@type":"WebSite"');
  });

  test("SSR should include breadcrumbs from @breadcrumbs parallel", async ({
    request,
  }) => {
    const response = await request.get(f.url("/parallel-meta/product-a"), {
      headers: { Accept: "text/html,application/xhtml+xml" },
    });
    const html = await response.text();

    // Breadcrumb trail should be in SSR HTML: Home / Store / Product A
    expect(html).toContain('aria-label="Breadcrumb"');
    expect(html).toContain("Store");
    expect(html).toContain("Product A");
  });
});

// ============================================================================
// Cache regression: production — null-component parallels must not block cache
// ============================================================================

test.describe("parallel-meta-cache-regression (production)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "build",
  });

  test("route with @meta parallel (returns null) should be cacheable", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/parallel-meta/product-a"));
    await waitForHydration(page);
    await expect(page).toHaveTitle("Product A | Test Store");
    const firstTs = await page.getByTestId("pm-render-ts").textContent();

    await page.waitForTimeout(500);

    await page.goto(f.url("/parallel-meta/product-a"));
    await waitForHydration(page);
    const secondTs = await page.getByTestId("pm-render-ts").textContent();

    expect(secondTs).toBe(firstTs);
    await expect(page).toHaveTitle("Product A | Test Store");
  });
});

// ============================================================================
// Stale-bucket cleanup: layout-mounted parallel slot returning null on
// revalidation must clear the slot's previous handle data (no stuck title).
// ============================================================================

function staleBucketSuite(mode: "dev" | "build") {
  const f = useFixture({ root: "./e2e/test-app", mode });

  test("hard load with :item shows item title", async ({ page }) => {
    using _ = expectNoPageError(page);
    await page.goto(f.url("/parallel-meta-stale/foo"));
    await waitForHydration(page);
    await expect(page).toHaveTitle("Foo | Stale Test");
  });

  test("hard load index uses layout default (no slot push)", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await page.goto(f.url("/parallel-meta-stale"));
    await waitForHydration(page);
    await expect(page).toHaveTitle("Stale Test");
  });

  test("soft nav from item to index drops the slot's stale title", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await page.goto(f.url("/parallel-meta-stale/foo"));
    await waitForHydration(page);
    await expect(page).toHaveTitle("Foo | Stale Test");

    // Soft-nav to index. The slot revalidates (item changed from "foo" to
    // undefined), the handler runs but returns null without pushing Meta.
    // Without the cleanup fix, the slot's previous Meta bucket (Foo) lingers
    // and the title stays "Foo | Stale Test" instead of "Stale Test".
    await page.getByTestId("pm-stale-link-index").click();
    await expect(page.getByTestId("pm-stale-index")).toBeVisible();
    await expect(page).toHaveTitle("Stale Test");
  });

  test("soft nav between two items replaces the slot's title", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await page.goto(f.url("/parallel-meta-stale/foo"));
    await waitForHydration(page);
    await expect(page).toHaveTitle("Foo | Stale Test");

    await page.getByTestId("pm-stale-link-bar").click();
    await expect(page.getByTestId("pm-stale-item")).toContainText("Item: bar");
    await expect(page).toHaveTitle("Bar | Stale Test");
  });

  test("soft nav from index to item adds the slot's title", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await page.goto(f.url("/parallel-meta-stale"));
    await waitForHydration(page);
    await expect(page).toHaveTitle("Stale Test");

    await page.getByTestId("pm-stale-link-foo").click();
    await expect(page.getByTestId("pm-stale-item")).toContainText("Item: foo");
    await expect(page).toHaveTitle("Foo | Stale Test");
  });
}

test.describe("parallel-meta-stale-cleanup", () => {
  staleBucketSuite("dev");
});

test.describe("parallel-meta-stale-cleanup (production)", () => {
  staleBucketSuite("build");
});
