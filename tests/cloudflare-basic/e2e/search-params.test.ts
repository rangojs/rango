import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError, testId } from "./helper";

test.describe.configure({ mode: "serial" });

test.describe("search params", () => {
  const f = useFixture({
    root: ".",
    mode: "dev",
  });

  test("should render search page with typed search params", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/search?q=react&page=2&sort=stars"));
    await waitForHydration(page);

    await expect(testId(page, "search-page")).toBeVisible();
    await expect(testId(page, "search-q")).toContainText("q: react");
    await expect(testId(page, "search-page-num")).toContainText("page: 2");
    await expect(testId(page, "search-sort")).toContainText("sort: stars");
  });

  test("should coerce page param to number type", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/search?q=typescript&page=5"));
    await waitForHydration(page);

    await expect(testId(page, "search-q-type")).toContainText("q-type: string");
    await expect(testId(page, "search-page-type")).toContainText(
      "page-type: number",
    );
  });

  test("should omit missing optional params", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/search?q=react"));
    await waitForHydration(page);

    await expect(testId(page, "search-q")).toContainText("q: react");
    await expect(testId(page, "search-page-num")).toContainText(
      "page: undefined",
    );
    await expect(testId(page, "search-sort")).toContainText("sort: undefined");
  });

  test("should default required string to empty when missing", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/search"));
    await waitForHydration(page);

    await expect(testId(page, "search-q")).toContainText("q: ");
    await expect(testId(page, "search-q-type")).toContainText(
      "q-type: undefined",
    );
  });

  test("should generate next page URL with search params", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/search?q=react&page=3"));
    await waitForHydration(page);

    // Next page should be page 4
    await expect(testId(page, "search-next-page-url")).toContainText(
      "next-page: /search?q=react&page=4",
    );
  });

  test("should handle NaN page param as undefined", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/search?q=test&page=abc"));
    await waitForHydration(page);

    await expect(testId(page, "search-page-num")).toContainText(
      "page: undefined",
    );
  });
});

test.describe("search params (production)", () => {
  const f = useFixture({
    root: ".",
    mode: "build",
  });

  test("should parse typed search params in production", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/search?q=react&page=10&sort=downloads"));
    await waitForHydration(page);

    await expect(testId(page, "search-page")).toBeVisible();
    await expect(testId(page, "search-q")).toContainText("q: react");
    await expect(testId(page, "search-page-num")).toContainText("page: 10");
    await expect(testId(page, "search-sort")).toContainText("sort: downloads");
    await expect(testId(page, "search-page-type")).toContainText(
      "page-type: number",
    );
  });
});
