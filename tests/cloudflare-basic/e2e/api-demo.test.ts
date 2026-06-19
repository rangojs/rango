import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError, testId } from "./helper";

test.describe.configure({ mode: "serial" });

// Typed fetch with Rango.PathResponse against the in-app JSON API routes. The
// API handlers return static data (health/products), so the rendered values
// are deterministic in dev and the production build alike.
function describeApiDemo(mode: "dev" | "build") {
  const label = mode === "build" ? "production" : "dev";
  test.describe(`API demo - typed fetch with PathResponse (${label})`, () => {
    const f = useFixture({
      root: ".",
      mode,
    });

    test("should display fetched health data", async ({ page }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/api-demo"));
      await waitForHydration(page);

      // Wait for health data to load
      await expect(testId(page, "health-status")).toBeVisible({
        timeout: 10000,
      });
      await expect(testId(page, "health-status")).toHaveText("ok");
      await expect(testId(page, "health-timestamp")).not.toBeEmpty();
    });

    test("should display fetched products list", async ({ page }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/api-demo"));
      await waitForHydration(page);

      // Wait for products to load
      await expect(testId(page, "products-list")).toBeVisible({
        timeout: 10000,
      });
      await expect(testId(page, "product-1")).toBeVisible();
      await expect(testId(page, "product-1")).toContainText("Widget");
      await expect(testId(page, "product-2")).toBeVisible();
      await expect(testId(page, "product-2")).toContainText("Gadget");
      await expect(testId(page, "product-3")).toBeVisible();
      await expect(testId(page, "product-3")).toContainText("Doohickey");
    });

    test("should display fetched product detail", async ({ page }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/api-demo"));
      await waitForHydration(page);

      // Wait for product detail to load
      await expect(testId(page, "product-detail-id")).toBeVisible({
        timeout: 10000,
      });
      await expect(testId(page, "product-detail-id")).toHaveText("1");
      await expect(testId(page, "product-detail-name")).toContainText("Widget");
      await expect(testId(page, "product-detail-price")).toContainText("9.99");
      await expect(testId(page, "product-detail-description")).toContainText(
        "Details for product 1",
      );
    });

    test("should navigate to API demo via link", async ({ page }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/"));
      await waitForHydration(page);

      await testId(page, "nav-api-demo").click();
      await expect(page).toHaveURL(/\/api-demo/);
      await expect(testId(page, "api-demo-page")).toBeVisible();
      await expect(testId(page, "api-demo-title")).toHaveText("API Data Demo");

      // Verify data loads after client navigation
      await expect(testId(page, "health-status")).toBeVisible({
        timeout: 10000,
      });
      await expect(testId(page, "health-status")).toHaveText("ok");
    });
  });
}

describeApiDemo("dev");
describeApiDemo("build");
