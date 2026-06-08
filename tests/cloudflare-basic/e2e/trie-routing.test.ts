import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError, testId } from "./helper";

// Trie routing matrix. Run in BOTH dev and production (mode: "build"). The
// production describe MUST carry the "(production)" tag so the e2e-bucketing
// guard files it in the production project; the factory couples the build
// fixture to that tag so the two can never drift.
function describeTrieRouting(label: string, mode: "dev" | "build") {
  test.describe(label, () => {
    const f = useFixture({
      root: ".",
      mode,
    });

    // -------------------------------------------------------------------------
    // Bug 1 — Constrained param routes should fall back to wildcard on mismatch
    // -------------------------------------------------------------------------
    test.describe("Bug 1: constraint + wildcard fallback", () => {
      test("matching constraint (en) routes to locale-info", async ({
        page,
      }) => {
        using _ = expectNoPageError(page);

        await page.goto(f.url("/en/info"));
        await waitForHydration(page);

        await expect(testId(page, "locale-info-page")).toBeVisible();
        await expect(testId(page, "locale-value")).toHaveText("Locale: en");
      });

      test("matching constraint (fr) routes to locale-info", async ({
        page,
      }) => {
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

    // -------------------------------------------------------------------------
    // Bug 2 — Different param names at the same trie depth
    // -------------------------------------------------------------------------
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

    // -------------------------------------------------------------------------
    // Wildcard catch-all baseline
    // -------------------------------------------------------------------------
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

    // -------------------------------------------------------------------------
    // C1 — bare-prefix wildcard match (empty splat)
    // A request to the bare prefix "/files" must resolve "/files/*" with an
    // EMPTY splat, NOT regex-fallback to a corrupt "/file" redirect or fall to
    // the root "/*" catch-all.
    // -------------------------------------------------------------------------
    test.describe("C1: bare-prefix wildcard (empty splat)", () => {
      test("bare /files resolves /files/* with an empty splat", async ({
        page,
      }) => {
        using _ = expectNoPageError(page);

        const response = await page.goto(f.url("/files"));
        await waitForHydration(page);

        // No corrupt redirect to /file*; the prefixed wildcard owns it.
        expect(new URL(page.url()).pathname).toBe("/files");
        expect(response?.status()).toBe(200);
        await expect(testId(page, "files-wildcard-page")).toBeVisible();
        await expect(testId(page, "files-splat-value")).toHaveText(
          "Files splat: []",
        );
      });

      test("/files/a/b resolves /files/* with the deeper splat", async ({
        page,
      }) => {
        using _ = expectNoPageError(page);

        await page.goto(f.url("/files/a/b"));
        await waitForHydration(page);

        await expect(testId(page, "files-wildcard-page")).toBeVisible();
        await expect(testId(page, "files-splat-value")).toHaveText(
          "Files splat: [a/b]",
        );
      });
    });
  });
}

describeTrieRouting(
  "trie routing: constraint validation + param name collision",
  "dev",
);
describeTrieRouting(
  "trie routing: constraint validation + param name collision (production)",
  "build",
);
