import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError, testId } from "./helper";

// ---------------------------------------------------------------------------
// Bug: Param suffix patterns like /shop/:productId.html
//
// 1. The ".html" suffix is silently dropped during pattern parsing, so the
//    route matches any /shop/<value> — even without the .html suffix.
// 2. The param value includes the suffix (e.g. "123.html" instead of "123")
//    because the suffix is not separated from the captured group.
// 3. /shop/:categoryId (a plain param) is shadowed because the broken
//    /shop/:productId.html compiles to the identical regex.
// ---------------------------------------------------------------------------

test.describe("suffix params: /shop/:productId.html vs /shop/:categoryId", () => {
  const f = useFixture({
    root: ".",
    mode: "dev",
  });

  test("/shop/widget.html matches the .html route with correct param", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/shop/widget.html"));
    await waitForHydration(page);

    await expect(testId(page, "shop-product-page")).toBeVisible();
    // param should be "widget", NOT "widget.html"
    await expect(testId(page, "shop-product-id")).toHaveText("Product: widget");
  });

  test("/shop/123.html extracts only the param portion", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/shop/123.html"));
    await waitForHydration(page);

    await expect(testId(page, "shop-product-page")).toBeVisible();
    await expect(testId(page, "shop-product-id")).toHaveText("Product: 123");
  });

  test("/shop/electronics matches the category route, not the .html route", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/shop/electronics"));
    await waitForHydration(page);

    // Must hit the category page, NOT the product page
    await expect(testId(page, "shop-category-page")).toBeVisible();
    await expect(testId(page, "shop-category-id")).toHaveText(
      "Category: electronics",
    );
  });

  test("/shop/sale matches the category route", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/shop/sale"));
    await waitForHydration(page);

    await expect(testId(page, "shop-category-page")).toBeVisible();
    await expect(testId(page, "shop-category-id")).toHaveText("Category: sale");
  });

  test("/shop/widget.archive.html matches the LONGER suffix, not .html", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/shop/widget.archive.html"));
    await waitForHydration(page);

    // Longest-suffix-wins: must hit the .archive.html route with slug "widget",
    // NOT the .html product route (which would capture "widget.archive").
    await expect(testId(page, "shop-archive-page")).toBeVisible();
    await expect(testId(page, "shop-archive-slug")).toHaveText(
      "Archive: widget",
    );
  });
});

test.describe("suffix params: /shop/:productId.html vs /shop/:categoryId (production)", () => {
  const f = useFixture({
    root: ".",
    mode: "build",
  });

  test("/shop/widget.html matches the .html route with correct param", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/shop/widget.html"));
    await waitForHydration(page);

    await expect(testId(page, "shop-product-page")).toBeVisible();
    await expect(testId(page, "shop-product-id")).toHaveText("Product: widget");
  });

  test("/shop/electronics matches the category route", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/shop/electronics"));
    await waitForHydration(page);

    await expect(testId(page, "shop-category-page")).toBeVisible();
    await expect(testId(page, "shop-category-id")).toHaveText(
      "Category: electronics",
    );
  });

  test("/shop/widget.archive.html matches the LONGER suffix, not .html", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/shop/widget.archive.html"));
    await waitForHydration(page);

    await expect(testId(page, "shop-archive-page")).toBeVisible();
    await expect(testId(page, "shop-archive-slug")).toHaveText(
      "Archive: widget",
    );
  });
});
