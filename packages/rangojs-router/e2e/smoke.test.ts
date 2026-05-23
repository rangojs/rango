import { expect, test } from "@playwright/test";
import { x } from "tinyexec";
import path from "node:path";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError } from "./helper";

/**
 * Smoke tests for the e2e-basic app.
 *
 * Lightweight checks covering core routing features: SSR, navigation,
 * include(), URL params, intercept (modal), client-side href(), and basename.
 * Runs before the full test suite to fail fast on fundamental regressions.
 *
 * The e2e-basic app uses basename: "/app", so all routes are served under /app.
 * This validates that basename works end-to-end: server routing, reverse(),
 * client-side Link auto-prefixing, and href().
 *
 * Both dev and production describes target the same e2e-basic directory.
 * Serial mode at the file level prevents concurrent `pnpm dev` and
 * `pnpm build` from corrupting the shared .vite optimizer cache.
 *
 * The build runs once at file level so the production describe just starts
 * `pnpm preview` without rebuilding. Dev and production run in parallel
 * on separate workers since the build is done up front.
 */

const E2E_BASIC_ROOT = "./e2e/e2e-basic";

// Build once for the entire file — both dev and production reuse it.
// Dev mode doesn't need a build, but production does.
test.beforeAll(async () => {
  const cwd = path.resolve(E2E_BASIC_ROOT);
  await x("pnpm", ["build"], { nodeOptions: { cwd } });
});

// ============================================================================
// Dev mode
// ============================================================================

test.describe("smoke", () => {
  test.describe.configure({ mode: "serial" });

  const f = useFixture({
    root: E2E_BASIC_ROOT,
    mode: "dev",
    isolatedServer: true,
    readyPath: "/app",
  });

  test("SSR renders home page", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/app"));
    await waitForHydration(page);

    await expect(page.getByTestId("home-page")).toBeVisible();
    await expect(page.getByTestId("home-title")).toHaveText("Welcome");
  });

  test("layout structure renders", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/app"));
    await waitForHydration(page);

    await expect(page.getByTestId("app-root")).toBeVisible();
    await expect(page.getByTestId("header")).toBeVisible();
    await expect(page.getByTestId("main-nav")).toBeVisible();
    await expect(page.getByTestId("footer")).toBeVisible();
  });

  test("client navigation to about", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/app"));
    await waitForHydration(page);

    await page.getByTestId("nav-about").click();
    await expect(page.getByTestId("about-page")).toBeVisible();
    expect(page.url()).toContain("/app/about");
  });

  test("include: blog routes", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/app"));
    await waitForHydration(page);

    await page.getByTestId("nav-blog").click();
    await expect(page.getByTestId("blog-layout")).toBeVisible();
    await expect(page.getByTestId("blog-index-page")).toBeVisible();
  });

  test("URL params: blog post", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/app/blog"));
    await waitForHydration(page);

    await page.getByTestId("post-link-1").click();
    await expect(page.getByTestId("post-title")).toHaveText(
      "Post: hello-world",
    );
  });

  test("include: shop routes", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/app"));
    await waitForHydration(page);

    await page.getByTestId("nav-shop").click();
    await expect(page.getByTestId("shop-layout")).toBeVisible();
    await expect(page.getByTestId("shop-index-page")).toBeVisible();
  });

  test("intercept: modal on soft navigation from shop", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/app/shop"));
    await waitForHydration(page);

    await page.getByTestId("product-link-1").click();
    await expect(page.getByTestId("product-modal")).toBeVisible();
    await expect(page.getByTestId("modal-product-name")).toHaveText("widget");
  });

  test("intercept: direct visit shows full page, not modal", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/app/shop/product/widget"));
    await waitForHydration(page);

    await expect(page.getByTestId("product-detail-page")).toBeVisible();
    await expect(page.getByTestId("product-modal")).not.toBeVisible();
  });

  test("nested navigation: shop to cart", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/app/shop"));
    await waitForHydration(page);

    await page.getByTestId("shop-cart-link").click();
    await expect(page.getByTestId("cart-page")).toBeVisible();
  });

  test("href() returns raw paths (not basename-aware)", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/app"));
    await waitForHydration(page);

    await expect(page.getByTestId("href-path-result")).toHaveText("/app/about");
    await expect(page.getByTestId("href-absolute-result")).toHaveText(
      "/app/shop/cart",
    );
    await expect(page.getByTestId("href-params-result")).toHaveText(
      "/app/blog/test",
    );
  });
});

// ============================================================================
// Production mode
// ============================================================================

test.describe("smoke (production)", () => {
  const f = useFixture({
    root: E2E_BASIC_ROOT,
    mode: "build",
    buildCommand: "true", // already built at file level
    readyPath: "/app",
  });

  test("SSR renders home page", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/app"));
    await waitForHydration(page);

    await expect(page.getByTestId("home-page")).toBeVisible();
    await expect(page.getByTestId("home-title")).toHaveText("Welcome");
  });

  test("layout structure renders", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/app"));
    await waitForHydration(page);

    await expect(page.getByTestId("app-root")).toBeVisible();
    await expect(page.getByTestId("header")).toBeVisible();
    await expect(page.getByTestId("main-nav")).toBeVisible();
    await expect(page.getByTestId("footer")).toBeVisible();
  });

  test("client navigation to about", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/app"));
    await waitForHydration(page);

    await page.getByTestId("nav-about").click();
    await expect(page.getByTestId("about-page")).toBeVisible();
    expect(page.url()).toContain("/app/about");
  });

  test("include: blog routes", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/app"));
    await waitForHydration(page);

    await page.getByTestId("nav-blog").click();
    await expect(page.getByTestId("blog-layout")).toBeVisible();
    await expect(page.getByTestId("blog-index-page")).toBeVisible();
  });

  test("URL params: blog post", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/app/blog"));
    await waitForHydration(page);

    await page.getByTestId("post-link-1").click();
    await expect(page.getByTestId("post-title")).toHaveText(
      "Post: hello-world",
    );
  });

  test("include: shop routes", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/app"));
    await waitForHydration(page);

    await page.getByTestId("nav-shop").click();
    await expect(page.getByTestId("shop-layout")).toBeVisible();
    await expect(page.getByTestId("shop-index-page")).toBeVisible();
  });

  test("intercept: modal on soft navigation from shop", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/app/shop"));
    await waitForHydration(page);

    await page.getByTestId("product-link-1").click();
    await expect(page.getByTestId("product-modal")).toBeVisible();
    await expect(page.getByTestId("modal-product-name")).toHaveText("widget");
  });

  test("intercept: direct visit shows full page, not modal", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/app/shop/product/widget"));
    await waitForHydration(page);

    await expect(page.getByTestId("product-detail-page")).toBeVisible();
    await expect(page.getByTestId("product-modal")).not.toBeVisible();
  });

  test("nested navigation: shop to cart", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/app/shop"));
    await waitForHydration(page);

    await page.getByTestId("shop-cart-link").click();
    await expect(page.getByTestId("cart-page")).toBeVisible();
  });

  test("href() returns raw paths (not basename-aware)", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/app"));
    await waitForHydration(page);

    await expect(page.getByTestId("href-path-result")).toHaveText("/app/about");
    await expect(page.getByTestId("href-absolute-result")).toHaveText(
      "/app/shop/cart",
    );
    await expect(page.getByTestId("href-params-result")).toHaveText(
      "/app/blog/test",
    );
  });
});
