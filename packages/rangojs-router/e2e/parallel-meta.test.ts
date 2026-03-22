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

    const jsonLd = page.locator('script[type="application/ld+json"]');
    await expect(jsonLd).toHaveCount(1);
    const content = await jsonLd.textContent();
    const parsed = JSON.parse(content!);
    expect(parsed["@context"]).toBe("https://schema.org");
    expect(parsed["@type"]).toBe("Product");
    expect(parsed.name).toBe("Product A");
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

    // JSON-LD should appear
    const jsonLd = page.locator('script[type="application/ld+json"]');
    await expect(jsonLd).toHaveCount(1);
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

    // JSON-LD should be gone
    const jsonLd = page.locator('script[type="application/ld+json"]');
    await expect(jsonLd).toHaveCount(0);

    // Breadcrumb should show only layout's "Store" (no product breadcrumb)
    await expect(page.getByTestId("breadcrumbs-current")).toHaveText("Store");
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

    const jsonLd = page.locator('script[type="application/ld+json"]');
    await expect(jsonLd).toHaveCount(1);
    const content = await jsonLd.textContent();
    const parsed = JSON.parse(content!);
    expect(parsed["@type"]).toBe("Product");
    expect(parsed.name).toBe("Product B");
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
  });

  test("soft nav back to index should restore defaults", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/parallel-meta/product-a"));
    await waitForHydration(page);
    await expect(page).toHaveTitle("Product A | Test Store");

    await page.getByTestId("pm-link-index").click();
    await expect(page.getByTestId("pm-index-page")).toBeVisible();
    await expect(page).toHaveTitle("Test Store");

    const jsonLd = page.locator('script[type="application/ld+json"]');
    await expect(jsonLd).toHaveCount(0);

    await expect(page.getByTestId("breadcrumbs-current")).toHaveText("Store");
  });

  test("SSR should include meta from @meta parallel", async ({ request }) => {
    const response = await request.get(f.url("/parallel-meta/product-a"), {
      headers: { Accept: "text/html,application/xhtml+xml" },
    });
    const html = await response.text();

    expect(html).toContain("<title>Product A | Test Store</title>");
    expect(html).toContain("Details for Product A");
    expect(html).toContain('type="application/ld+json"');
  });
});
