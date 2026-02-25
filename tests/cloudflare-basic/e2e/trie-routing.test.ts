import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError, testId } from "./helper";

test.describe("trie routing: constraint validation + param name collision", () => {
  const f = useFixture({
    root: ".",
    mode: "dev",
  });

  // ---------------------------------------------------------------------------
  // Bug 1 — Constrained param routes should fall back to wildcard on mismatch
  // ---------------------------------------------------------------------------
  test.describe("Bug 1: constraint + wildcard fallback", () => {
    test("matching constraint (en) routes to locale-info", async ({ page }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/en/info"));
      await waitForHydration(page);

      await expect(testId(page, "locale-info-page")).toBeVisible();
      await expect(testId(page, "locale-value")).toHaveText("Locale: en");
    });

    test("matching constraint (fr) routes to locale-info", async ({ page }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/fr/info"));
      await waitForHydration(page);

      await expect(testId(page, "locale-info-page")).toBeVisible();
      await expect(testId(page, "locale-value")).toHaveText("Locale: fr");
    });

    test("non-matching constraint (de) falls through to catch-all", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/de/info"));
      await waitForHydration(page);

      await expect(testId(page, "catch-all-page")).toBeVisible();
      await expect(testId(page, "wildcard-value")).toHaveText(
        "Wildcard: de/info",
      );
    });

    test("non-matching constraint (es) falls through to catch-all", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/es/info"));
      await waitForHydration(page);

      await expect(testId(page, "catch-all-page")).toBeVisible();
      await expect(testId(page, "wildcard-value")).toHaveText(
        "Wildcard: es/info",
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Bug 2 — Different param names at the same trie depth
  // ---------------------------------------------------------------------------
  test.describe("Bug 2: param name collision", () => {
    test("/item/:itemId/detail renders correct param name", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/item/123/detail"));
      await waitForHydration(page);

      await expect(testId(page, "item-detail-page")).toBeVisible();
      await expect(testId(page, "item-id-value")).toHaveText("Item ID: 123");
    });

    test("/item/:productId/reviews renders correct param name", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/item/456/reviews"));
      await waitForHydration(page);

      await expect(testId(page, "product-reviews-page")).toBeVisible();
      await expect(testId(page, "product-id-value")).toHaveText(
        "Product ID: 456",
      );
    });

    test("params stay correct across sequential navigations", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      // First visit item detail
      await page.goto(f.url("/item/aaa/detail"));
      await waitForHydration(page);
      await expect(testId(page, "item-id-value")).toHaveText("Item ID: aaa");

      // Then navigate to product reviews
      await page.goto(f.url("/item/bbb/reviews"));
      await waitForHydration(page);
      await expect(testId(page, "product-id-value")).toHaveText(
        "Product ID: bbb",
      );

      // Back to item detail with different value
      await page.goto(f.url("/item/ccc/detail"));
      await waitForHydration(page);
      await expect(testId(page, "item-id-value")).toHaveText("Item ID: ccc");
    });
  });

  // ---------------------------------------------------------------------------
  // Wildcard catch-all baseline
  // ---------------------------------------------------------------------------
  test.describe("wildcard catch-all baseline", () => {
    test("multi-segment path matches catch-all", async ({ page }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/some/random/path"));
      await waitForHydration(page);

      await expect(testId(page, "catch-all-page")).toBeVisible();
      await expect(testId(page, "wildcard-value")).toHaveText(
        "Wildcard: some/random/path",
      );
    });

    test("single-segment path matches catch-all", async ({ page }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/random"));
      await waitForHydration(page);

      await expect(testId(page, "catch-all-page")).toBeVisible();
      await expect(testId(page, "wildcard-value")).toHaveText(
        "Wildcard: random",
      );
    });
  });
});
