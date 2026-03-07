import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, testId } from "./helper";

/**
 * Asserts exact breadcrumb trail: order, content, AND count.
 * Selects only label <li> elements (excludes async-content <li> which
 * carries data-testid="breadcrumbs-content").
 */
async function expectBreadcrumbOrder(
  container: ReturnType<typeof testId> extends infer T ? T : never,
  labels: string[],
) {
  const labelItems = container.locator("ol > li:not([data-testid])");
  await expect(labelItems).toHaveCount(labels.length);
  for (let i = 0; i < labels.length; i++) {
    await expect(labelItems.nth(i)).toContainText(labels[i]);
  }
}

/**
 * Handle API tests - breadcrumbs accumulated across route segments.
 * expectBreadcrumbOrder enforces exact label count and ordered content
 * via toHaveCount + nth(i) assertions on label <li> elements.
 */

function breadcrumbTests(mode: "dev" | "build") {
  const label = mode === "build" ? "production" : mode;
  test.describe(`handle-breadcrumbs (${label})`, () => {
    const f = useFixture({
      root: "./e2e/test-app",
      mode,
    });

    test("should display home breadcrumb on index page", async ({ page }) => {
      await page.goto(f.url("/"));
      await waitForHydration(page);

      const breadcrumbs = testId(page, "breadcrumbs");
      await expect(breadcrumbs).toBeVisible();

      // Exactly one breadcrumb: Home (as current, not a link)
      await expectBreadcrumbOrder(breadcrumbs, ["Home"]);
      await expect(testId(page, "breadcrumbs-current")).toHaveText("Home");
    });

    test("should display ordered breadcrumbs on product page", async ({
      page,
    }) => {
      await page.goto(f.url("/product/product-a"));
      await waitForHydration(page);

      const breadcrumbs = testId(page, "breadcrumbs");
      await expect(breadcrumbs).toBeVisible();

      // Ordered: Home > Product A
      await expectBreadcrumbOrder(breadcrumbs, ["Home", "Product A"]);
      // Home is a link, Product A is current
      await expect(testId(page, "breadcrumbs-link-home")).toBeVisible();
      await expect(testId(page, "breadcrumbs-current")).toHaveText("Product A");
    });

    test("should display ordered breadcrumbs on blog index", async ({
      page,
    }) => {
      await page.goto(f.url("/blog"));
      await waitForHydration(page);

      const breadcrumbs = testId(page, "breadcrumbs");
      await expect(breadcrumbs).toBeVisible();

      // Ordered: Home > Blog
      await expectBreadcrumbOrder(breadcrumbs, ["Home", "Blog"]);
      await expect(testId(page, "breadcrumbs-current")).toHaveText("Blog");
    });

    test("should display three-level ordered breadcrumbs on blog post", async ({
      page,
    }) => {
      await page.goto(f.url("/blog/post-1"));
      await waitForHydration(page);

      const breadcrumbs = testId(page, "breadcrumbs");
      await expect(breadcrumbs).toBeVisible();

      // Ordered: Home > Blog > Post post-1
      await expectBreadcrumbOrder(breadcrumbs, ["Home", "Blog", "Post post-1"]);
      // Home and Blog are links, Post is current
      await expect(testId(page, "breadcrumbs-link-home")).toBeVisible();
      await expect(testId(page, "breadcrumbs-link-blog")).toBeVisible();
      await expect(testId(page, "breadcrumbs-current")).toHaveText(
        "Post post-1",
      );
    });

    test("should show a clear error when breadcrumbs are pushed late during jsx render", async ({
      page,
    }) => {
      await page.goto(f.url("/delayed-breadcrumbs"));

      if (mode === "dev") {
        // Dev mode shows the specific error messages
        await expect(
          page
            .getByText(/was pushed after handle collection completed/i)
            .first(),
        ).toBeVisible();
        await expect(
          page.getByText(
            /async jsx subtree suspended and later tried to push a handle/i,
          ),
        ).toBeVisible();
      } else {
        // Production builds strip the specific message but React's RSC error
        // includes "Server Components render" — more specific than generic "error"
        await expect(
          page.getByText(/Server Components render/i).first(),
        ).toBeVisible();
      }
    });

    test("should update breadcrumbs via router navigation, not hard nav", async ({
      page,
    }) => {
      await page.goto(f.url("/"));
      await waitForHydration(page);

      const breadcrumbs = testId(page, "breadcrumbs");

      // Initially only "Home" breadcrumb
      await expectBreadcrumbOrder(breadcrumbs, ["Home"]);

      // Navigate via router link (soft navigation), not page.goto
      await testId(page, "link-status-blog").click();
      await expect(testId(page, "blog-index-page")).toBeVisible({
        timeout: 5000,
      });

      // Breadcrumbs should now show Home > Blog
      await expectBreadcrumbOrder(breadcrumbs, ["Home", "Blog"]);
    });

    test("should update breadcrumbs on back navigation", async ({ page }) => {
      await page.goto(f.url("/blog"));
      await waitForHydration(page);

      const breadcrumbs = testId(page, "breadcrumbs");

      // Home > Blog
      await expectBreadcrumbOrder(breadcrumbs, ["Home", "Blog"]);

      // Navigate back to home using breadcrumb link (soft navigation)
      await testId(page, "breadcrumbs-link-home").click();
      await expect(testId(page, "index-page")).toBeVisible({ timeout: 5000 });

      // Only Home should remain
      await expectBreadcrumbOrder(breadcrumbs, ["Home"]);
      await expect(breadcrumbs.locator("text=Blog")).not.toBeVisible();
    });

    test("should show skeleton while async breadcrumb content loads", async ({
      page,
    }) => {
      // Navigate with waitUntil: "commit" to observe the initial streamed HTML
      // before the 1s async breadcrumb promise resolves. The server streams
      // the Suspense fallback (skeleton) first, then the resolved content.
      await page.goto(f.url("/product/product-a"), { waitUntil: "commit" });

      // Skeleton must appear in the initial streamed HTML
      const skeleton = testId(page, "breadcrumbs-skeleton");
      await expect(skeleton).toBeVisible({ timeout: 5000 });

      // After the async content resolves, skeleton disappears
      await expect(testId(page, "breadcrumb-async")).toBeVisible({
        timeout: 5000,
      });
      await expect(skeleton).not.toBeVisible();
    });

    test("should stream async breadcrumb content", async ({ page }) => {
      await page.goto(f.url("/product/product-a"));
      await waitForHydration(page);

      // Wait for async content to stream in
      await expect(testId(page, "breadcrumb-async")).toBeVisible({
        timeout: 5000,
      });
      await expect(testId(page, "breadcrumb-async")).toContainText("Loaded:");
    });

    test("should not show hydration mismatch for breadcrumbs", async ({
      page,
    }) => {
      const hydrationErrors: string[] = [];

      page.on("console", (msg) => {
        const text = msg.text();
        if (
          text.includes("Hydration failed") ||
          text.includes("hydration mismatch") ||
          text.includes("Text content does not match")
        ) {
          hydrationErrors.push(text);
        }
      });

      await page.goto(f.url("/"));
      await waitForHydration(page);
      expect(hydrationErrors).toEqual([]);

      await page.goto(f.url("/product/product-a"));
      await waitForHydration(page);
      expect(hydrationErrors).toEqual([]);

      await page.goto(f.url("/blog"));
      await waitForHydration(page);
      expect(hydrationErrors).toEqual([]);

      await page.goto(f.url("/blog/post-1"));
      await waitForHydration(page);
      expect(hydrationErrors).toEqual([]);
    });

    test("should update breadcrumbs correctly during soft navigation", async ({
      page,
    }) => {
      await page.goto(f.url("/blog"));
      await waitForHydration(page);

      const breadcrumbs = testId(page, "breadcrumbs");

      // Navigate to post-1
      await testId(page, "blog-post-link-1").click();
      await expect(testId(page, "blog-post-page")).toBeVisible({
        timeout: 5000,
      });

      // Ordered: Home > Blog > Post post-1
      await expectBreadcrumbOrder(breadcrumbs, ["Home", "Blog", "Post post-1"]);

      // Navigate back to blog
      await testId(page, "back-to-blog").click();
      await expect(testId(page, "blog-index-page")).toBeVisible({
        timeout: 5000,
      });

      // Post breadcrumb should be gone: Home > Blog
      await expectBreadcrumbOrder(breadcrumbs, ["Home", "Blog"]);
      await expect(breadcrumbs.locator("text=Post post-1")).not.toBeVisible();

      // Navigate to post-2
      await testId(page, "blog-post-link-2").click();
      await expect(testId(page, "blog-post-page")).toBeVisible({
        timeout: 5000,
      });

      // Ordered: Home > Blog > Post post-2
      await expectBreadcrumbOrder(breadcrumbs, ["Home", "Blog", "Post post-2"]);
      await expect(breadcrumbs.locator("text=Post post-1")).not.toBeVisible();
    });

    test("should NOT show skeleton when action triggers revalidation", async ({
      page,
    }) => {
      test.slow();

      await page.goto(f.url("/product/product-b"));
      await waitForHydration(page);

      // Wait for async breadcrumb content to fully load
      await expect(testId(page, "breadcrumb-async")).toBeVisible({
        timeout: 10000,
      });

      // Ensure skeleton is NOT visible before action
      await expect(testId(page, "breadcrumbs-skeleton")).not.toBeVisible({
        timeout: 3000,
      });

      // Trigger revalidation via action
      await testId(page, "add-to-cart-btn").click();

      await expect(page.locator("text=Added product-b to cart")).toBeVisible({
        timeout: 15000,
      });

      // Async content should still be visible, skeleton should not reappear
      await expect(testId(page, "breadcrumb-async")).toBeVisible();
      await expect(testId(page, "breadcrumbs-skeleton")).not.toBeVisible();
    });
  });
}

// Run all tests in both dev and production modes
breadcrumbTests("dev");
breadcrumbTests("build");
