import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError, testId } from "./helper";

/**
 * Tests for typed search params feature:
 * - ctx.searchParams as typed object (not URLSearchParams)
 * - Number and boolean coercion from query string
 * - Optional params omitted when missing
 * - ctx.reverse with search params appends query string
 * - Combined route params + search params
 */
test.describe("Typed Search Params", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });

  test.describe("Search index route (required + optional params)", () => {
    test("should parse required string and optional number from query string", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/search?q=react&page=2"));
      await waitForHydration(page);

      await expect(testId(page, "search-page")).toBeVisible();
      await expect(testId(page, "search-q")).toContainText("q: react");
      await expect(testId(page, "search-page-num")).toContainText("page: 2");
      // q is always string, page should be number (coerced from "2")
      await expect(testId(page, "search-q-type")).toContainText(
        "q-type: string",
      );
      await expect(testId(page, "search-page-type")).toContainText(
        "page-type: number",
      );
    });

    test("should handle all params present", async ({ page }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/search?q=typescript&page=3&sort=stars"));
      await waitForHydration(page);

      await expect(testId(page, "search-q")).toContainText("q: typescript");
      await expect(testId(page, "search-page-num")).toContainText("page: 3");
      await expect(testId(page, "search-sort")).toContainText("sort: stars");
    });

    test("should omit missing optional params", async ({ page }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/search?q=react"));
      await waitForHydration(page);

      await expect(testId(page, "search-q")).toContainText("q: react");
      await expect(testId(page, "search-page-num")).toContainText(
        "page: undefined",
      );
      await expect(testId(page, "search-sort")).toContainText(
        "sort: undefined",
      );
      await expect(testId(page, "search-page-type")).toContainText(
        "page-type: undefined",
      );
    });

    test("should default required string to empty when missing", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/search"));
      await waitForHydration(page);

      // Required string defaults to "" when not in query string
      await expect(testId(page, "search-q")).toContainText("q: ");
      await expect(testId(page, "search-q-type")).toContainText(
        "q-type: string",
      );
    });

    test("should handle NaN numbers as omitted", async ({ page }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/search?q=test&page=abc"));
      await waitForHydration(page);

      // "abc" is not a valid number, optional number should be omitted
      await expect(testId(page, "search-q")).toContainText("q: test");
      await expect(testId(page, "search-page-num")).toContainText(
        "page: undefined",
      );
    });
  });

  test.describe("ctx.reverse with search params", () => {
    test("should generate URL with query string via reverse", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/search?q=anything"));
      await waitForHydration(page);

      // reverse("index", {}, { q: "test", page: 2 }) should produce /search?q=test&page=2
      await expect(testId(page, "search-self-url")).toContainText(
        "self: /search?q=test&page=2",
      );
    });

    test("should generate detail URL with route params and search params", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/search?q=anything"));
      await waitForHydration(page);

      // reverse("detail", { category: "books" }, { q: "typescript", active: true })
      await expect(testId(page, "search-detail-url")).toContainText(
        "detail: /search/books?q=typescript&active=true",
      );
    });
  });

  test.describe("Search detail route (route params + search params)", () => {
    test("should parse route params and search params together", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/search/electronics?q=laptop&active=true"));
      await waitForHydration(page);

      await expect(testId(page, "search-detail-page")).toBeVisible();
      await expect(testId(page, "detail-category")).toContainText(
        "category: electronics",
      );
      await expect(testId(page, "detail-q")).toContainText("q: laptop");
      await expect(testId(page, "detail-active")).toContainText("active: true");
      await expect(testId(page, "detail-active-type")).toContainText(
        "active-type: boolean",
      );
    });

    test("should handle boolean false values", async ({ page }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/search/books?active=false"));
      await waitForHydration(page);

      await expect(testId(page, "detail-active")).toContainText(
        "active: false",
      );
      await expect(testId(page, "detail-active-type")).toContainText(
        "active-type: boolean",
      );
    });

    test("should omit missing optional search params on detail route", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/search/games"));
      await waitForHydration(page);

      await expect(testId(page, "detail-category")).toContainText(
        "category: games",
      );
      await expect(testId(page, "detail-q")).toContainText("q: undefined");
      await expect(testId(page, "detail-active")).toContainText(
        "active: undefined",
      );
    });
  });

  test.describe("Client-side navigation with search params", () => {
    test("should navigate to detail route with search params", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/search?q=initial"));
      await waitForHydration(page);

      // Click detail link which navigates to /search/books?q=typescript&active=true
      // (different path, so RSC router fetches new data)
      await testId(page, "search-detail-link").click();
      await expect(page).toHaveURL(/\/search\/books/);
      await expect(testId(page, "search-detail-page")).toBeVisible();
      await expect(testId(page, "detail-category")).toContainText(
        "category: books",
      );
      await expect(testId(page, "detail-q")).toContainText("q: typescript");
    });
  });
});

test.describe("Typed Search Params (production)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "build",
  });

  test("should parse typed search params in production build", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/search?q=react&page=5&sort=downloads"));
    await waitForHydration(page);

    await expect(testId(page, "search-page")).toBeVisible();
    await expect(testId(page, "search-q")).toContainText("q: react");
    await expect(testId(page, "search-page-num")).toContainText("page: 5");
    await expect(testId(page, "search-sort")).toContainText("sort: downloads");
    await expect(testId(page, "search-q-type")).toContainText("q-type: string");
    await expect(testId(page, "search-page-type")).toContainText(
      "page-type: number",
    );
  });

  test("should parse search params on detail route in production", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/search/tools?q=vscode&active=true"));
    await waitForHydration(page);

    await expect(testId(page, "search-detail-page")).toBeVisible();
    await expect(testId(page, "detail-category")).toContainText(
      "category: tools",
    );
    await expect(testId(page, "detail-q")).toContainText("q: vscode");
    await expect(testId(page, "detail-active")).toContainText("active: true");
    await expect(testId(page, "detail-active-type")).toContainText(
      "active-type: boolean",
    );
  });

  test("should generate reverse URLs with search params in production", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/search?q=anything"));
    await waitForHydration(page);

    await expect(testId(page, "search-self-url")).toContainText(
      "self: /search?q=test&page=2",
    );
    await expect(testId(page, "search-detail-url")).toContainText(
      "detail: /search/books?q=typescript&active=true",
    );
  });
});
