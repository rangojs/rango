import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError } from "./helper";

/**
 * Smoke tests for the e2e-basic app.
 *
 * Lightweight checks covering core routing features: SSR, navigation,
 * include(), URL params, intercept (modal), and client-side href().
 * Runs before the full test suite to fail fast on fundamental regressions.
 *
 * Both dev and production describes target the same e2e-basic directory.
 * Serial mode at the file level prevents concurrent `pnpm dev` and
 * `pnpm build` from corrupting the shared .vite optimizer cache.
 */
test.describe.configure({ mode: "serial" });

// ============================================================================
// Dev mode
// ============================================================================

test.describe("smoke", () => {

  const f = useFixture({
    root: "./e2e/e2e-basic",
    mode: "dev",
    isolatedServer: true,
  });

  test("SSR renders home page", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/"));
    await waitForHydration(page);

    await expect(page.getByTestId("home-page")).toBeVisible();
    await expect(page.getByTestId("home-title")).toHaveText("Welcome");
  });

  test("layout structure renders", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/"));
    await waitForHydration(page);

    await expect(page.getByTestId("app-root")).toBeVisible();
    await expect(page.getByTestId("header")).toBeVisible();
    await expect(page.getByTestId("main-nav")).toBeVisible();
    await expect(page.getByTestId("footer")).toBeVisible();
  });

  test("client navigation to about", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/"));
    await waitForHydration(page);

    await page.getByTestId("nav-about").click();
    await expect(page.getByTestId("about-page")).toBeVisible();
    expect(page.url()).toContain("/about");
  });

  test("include: blog routes", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/"));
    await waitForHydration(page);

    await page.getByTestId("nav-blog").click();
    await expect(page.getByTestId("blog-layout")).toBeVisible();
    await expect(page.getByTestId("blog-index-page")).toBeVisible();
  });

  test("URL params: blog post", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/blog"));
    await waitForHydration(page);

    await page.getByTestId("post-link-1").click();
    await expect(page.getByTestId("post-title")).toHaveText(
      "Post: hello-world",
    );
  });

  test("include: shop routes", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/"));
    await waitForHydration(page);

    await page.getByTestId("nav-shop").click();
    await expect(page.getByTestId("shop-layout")).toBeVisible();
    await expect(page.getByTestId("shop-index-page")).toBeVisible();
  });

  test("intercept: modal on soft navigation from shop", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/shop"));
    await waitForHydration(page);

    await page.getByTestId("product-link-1").click();
    await expect(page.getByTestId("product-modal")).toBeVisible();
    await expect(page.getByTestId("modal-product-name")).toHaveText("widget");
  });

  test("intercept: direct visit shows full page, not modal", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/shop/product/widget"));
    await waitForHydration(page);

    await expect(page.getByTestId("product-detail-page")).toBeVisible();
    await expect(page.getByTestId("product-modal")).not.toBeVisible();
  });

  test("nested navigation: shop to cart", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/shop"));
    await waitForHydration(page);

    await page.getByTestId("shop-cart-link").click();
    await expect(page.getByTestId("cart-page")).toBeVisible();
  });

  test("href() client function resolves paths", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/"));
    await waitForHydration(page);

    await expect(page.getByTestId("href-path-result")).toHaveText("/about");
    await expect(page.getByTestId("href-absolute-result")).toHaveText(
      "/shop/cart",
    );
    await expect(page.getByTestId("href-params-result")).toHaveText(
      "/blog/test",
    );
  });
});

// ============================================================================
// Production mode
// ============================================================================

test.describe("smoke (production)", () => {
  const f = useFixture({
    root: "./e2e/e2e-basic",
    mode: "build",
  });

  test("SSR renders home page", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/"));
    await waitForHydration(page);

    await expect(page.getByTestId("home-page")).toBeVisible();
    await expect(page.getByTestId("home-title")).toHaveText("Welcome");
  });

  test("layout structure renders", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/"));
    await waitForHydration(page);

    await expect(page.getByTestId("app-root")).toBeVisible();
    await expect(page.getByTestId("header")).toBeVisible();
    await expect(page.getByTestId("main-nav")).toBeVisible();
    await expect(page.getByTestId("footer")).toBeVisible();
  });

  test("client navigation to about", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/"));
    await waitForHydration(page);

    await page.getByTestId("nav-about").click();
    await expect(page.getByTestId("about-page")).toBeVisible();
    expect(page.url()).toContain("/about");
  });

  test("include: blog routes", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/"));
    await waitForHydration(page);

    await page.getByTestId("nav-blog").click();
    await expect(page.getByTestId("blog-layout")).toBeVisible();
    await expect(page.getByTestId("blog-index-page")).toBeVisible();
  });

  test("URL params: blog post", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/blog"));
    await waitForHydration(page);

    await page.getByTestId("post-link-1").click();
    await expect(page.getByTestId("post-title")).toHaveText(
      "Post: hello-world",
    );
  });

  test("include: shop routes", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/"));
    await waitForHydration(page);

    await page.getByTestId("nav-shop").click();
    await expect(page.getByTestId("shop-layout")).toBeVisible();
    await expect(page.getByTestId("shop-index-page")).toBeVisible();
  });

  test("intercept: modal on soft navigation from shop", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/shop"));
    await waitForHydration(page);

    await page.getByTestId("product-link-1").click();
    await expect(page.getByTestId("product-modal")).toBeVisible();
    await expect(page.getByTestId("modal-product-name")).toHaveText("widget");
  });

  test("intercept: direct visit shows full page, not modal", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/shop/product/widget"));
    await waitForHydration(page);

    await expect(page.getByTestId("product-detail-page")).toBeVisible();
    await expect(page.getByTestId("product-modal")).not.toBeVisible();
  });

  test("nested navigation: shop to cart", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/shop"));
    await waitForHydration(page);

    await page.getByTestId("shop-cart-link").click();
    await expect(page.getByTestId("cart-page")).toBeVisible();
  });

  test("href() client function resolves paths", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/"));
    await waitForHydration(page);

    await expect(page.getByTestId("href-path-result")).toHaveText("/about");
    await expect(page.getByTestId("href-absolute-result")).toHaveText(
      "/shop/cart",
    );
    await expect(page.getByTestId("href-params-result")).toHaveText(
      "/blog/test",
    );
  });
});
