import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError, testId } from "./helper";

/**
 * Tests for reverse resolution
 * - Server-side ctx.reverse in route handlers
 * - Client-side href() + useMount()
 * - Client-side useReverseRoutes() hook + createReverse()
 * - Local, absolute, and path-based resolution
 */
test.describe("Scoped Reverse Resolution", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });

  test.describe("Server-side ctx.reverse", () => {
    test("should resolve local route name to correct path", async ({ page }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/href"));
      await waitForHydration(page);

      // Local "index" should resolve to /href
      const localIndex = testId(page, "server-local-index");
      await expect(localIndex).toContainText("/href");
    });

    test("should resolve local route name with params", async ({ page }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/href"));
      await waitForHydration(page);

      // Local "detail" with id param should resolve to /href/123
      const localDetail = testId(page, "server-local-detail");
      await expect(localDetail).toContainText("/href/123");
    });

    test("should resolve absolute route name (with dot)", async ({ page }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/href"));
      await waitForHydration(page);

      // Absolute "blog.index" should resolve to /blog
      const absoluteBlog = testId(page, "server-absolute-blog");
      await expect(absoluteBlog).toContainText("/blog");
    });

    test("should pass through path-based URLs unchanged", async ({ page }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/href"));
      await waitForHydration(page);

      // Path-based "/about" should remain /about
      const pathBased = testId(page, "server-path-based");
      await expect(pathBased).toContainText("/about");
    });

    test("should resolve local names correctly from detail route", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/href/test-item"));
      await waitForHydration(page);

      // From detail route, local "index" should still resolve to /href
      const backIndex = testId(page, "detail-server-back-index");
      await expect(backIndex).toContainText("/href");

      // From detail route, local "detail" with params should resolve correctly
      const siblingDetail = testId(page, "detail-server-sibling");
      await expect(siblingDetail).toContainText("/href/sibling-item");
    });

    test("should resolve names from nested include context", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/href/nested"));
      await waitForHydration(page);

      // From nested context, local "index" should resolve to /href/nested
      const nestedIndex = testId(page, "nested-server-local-index");
      await expect(nestedIndex).toContainText("/href/nested");

      // From nested context, absolute "href.index" should resolve to /href
      const parentIndex = testId(page, "nested-server-parent-index");
      await expect(parentIndex).toContainText("/href");

      // From nested context, absolute "href.detail" with params should work
      const parentDetail = testId(page, "nested-server-parent-detail");
      await expect(parentDetail).toContainText("/href/from-nested");
    });
  });

  test.describe("Client-side href + useMount", () => {
    test("should resolve mount-relative path to correct URL", async ({ page }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/href"));
      await waitForHydration(page);

      // Client-side href("/", mount) where mount="/href" -> "/href/"
      const clientLocalIndex = testId(page, "client-local-index");
      await expect(clientLocalIndex).toContainText("/href/");
    });

    test("should resolve mount-relative path with dynamic segment", async ({ page }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/href"));
      await waitForHydration(page);

      // Client-side href("/from-client", mount) -> "/href/from-client"
      const clientLocalDetail = testId(page, "client-local-detail");
      await expect(clientLocalDetail).toContainText("/href/from-client");
    });

    test("should resolve absolute path without mount", async ({ page }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/href"));
      await waitForHydration(page);

      // Client-side href("/blog") -> "/blog" (no mount prefix)
      const clientAbsoluteBlog = testId(page, "client-absolute-blog");
      await expect(clientAbsoluteBlog).toContainText("/blog");
    });

    test("should pass through path-based URLs unchanged", async ({ page }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/href"));
      await waitForHydration(page);

      // Client-side href("/about") -> "/about"
      const clientPathBased = testId(page, "client-path-based");
      await expect(clientPathBased).toContainText("/about");
    });

    test("should maintain mount context after navigation", async ({ page }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/href"));
      await waitForHydration(page);

      // Click to navigate to detail page
      await testId(page, "goto-detail-link").click();
      await expect(page).toHaveURL(/\/href\/item-abc/);
      await expect(testId(page, "href-detail-page")).toBeVisible();

      // After navigation, client href resolves with isDetailPage=true
      // So it uses "/client-item" instead of "/from-client"
      const clientLocalDetail = testId(page, "client-local-detail");
      await expect(clientLocalDetail).toContainText("/href/client-item");
    });

  });

  test.describe("Client-side useReverseRoutes hook", () => {
    test("should reverse route without params", async ({ page }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/href"));
      await waitForHydration(page);

      // useReverseRoutes with gen file routes: index "/" -> "/"
      const hookIndex = testId(page, "reverse-hook-index");
      await expect(hookIndex).toContainText("/");
    });

    test("should reverse route with params", async ({ page }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/href"));
      await waitForHydration(page);

      // useReverseRoutes with gen file routes: detail "/:id" + { id: "42" } -> "/42"
      const hookDetail = testId(page, "reverse-hook-detail");
      await expect(hookDetail).toContainText("/42");
    });

    test("should work with createReverse (non-hook)", async ({ page }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/href"));
      await waitForHydration(page);

      // createReverse with gen file routes: detail "/:id" + { id: "static-99" } -> "/static-99"
      const staticDetail = testId(page, "reverse-static-detail");
      await expect(staticDetail).toContainText("/static-99");
    });

    test("should navigate using reversed URLs", async ({ page }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/href"));
      await waitForHydration(page);

      // Click link generated by useReverseRoutes
      await testId(page, "reverse-link-detail").click();
      await expect(page).toHaveURL(/\/42/);
    });
  });

  test.describe("Link navigation with reverse", () => {
    test("should navigate using server-rendered href links", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/href"));
      await waitForHydration(page);

      // Click the server-rendered blog link
      await testId(page, "server-link-absolute-blog").click();
      await expect(page).toHaveURL(/\/blog/);
      await expect(testId(page, "blog-index-page")).toBeVisible();
    });

    test("should navigate using client-rendered href links", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/href"));
      await waitForHydration(page);

      // Click the client-rendered blog link
      await testId(page, "client-link-absolute-blog").click();
      await expect(page).toHaveURL(/\/blog/);
      await expect(testId(page, "blog-index-page")).toBeVisible();
    });

    test("should navigate to detail page using local href", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/href"));
      await waitForHydration(page);

      // Click the server-rendered local detail link
      await testId(page, "server-link-local-detail").click();
      await expect(page).toHaveURL(/\/href\/123/);
      await expect(testId(page, "href-detail-page")).toBeVisible();
      await expect(testId(page, "detail-title")).toContainText("Detail: 123");
    });

    test("should navigate from nested route using absolute href", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/href/nested"));
      await waitForHydration(page);

      // Click the link to parent detail
      await testId(page, "nested-to-parent-detail-link").click();
      await expect(page).toHaveURL(/\/href\/from-nested/);
      await expect(testId(page, "href-detail-page")).toBeVisible();
      await expect(testId(page, "detail-title")).toContainText(
        "Detail: from-nested"
      );
    });
  });
});

test.describe("Scoped Reverse Resolution (production)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "build",
  });

  test("should resolve all href types correctly in production build", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/href"));
    await waitForHydration(page);

    // Server-side hrefs
    await expect(testId(page, "server-local-index")).toContainText("/href");
    await expect(testId(page, "server-local-detail")).toContainText("/href/123");
    await expect(testId(page, "server-absolute-blog")).toContainText("/blog");
    await expect(testId(page, "server-path-based")).toContainText("/about");

    // Client-side hrefs (href + useMount)
    await expect(testId(page, "client-local-index")).toContainText("/href/");
    await expect(testId(page, "client-local-detail")).toContainText("/href/from-client");
    await expect(testId(page, "client-absolute-blog")).toContainText("/blog");
    await expect(testId(page, "client-path-based")).toContainText("/about");

    // Client-side useReverseRoutes hook
    await expect(testId(page, "reverse-hook-index")).toContainText("/");
    await expect(testId(page, "reverse-hook-detail")).toContainText("/42");
    await expect(testId(page, "reverse-static-detail")).toContainText("/static-99");
  });

  test("should navigate correctly in production build", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/href"));
    await waitForHydration(page);

    // Navigate to detail using local href
    await testId(page, "server-link-local-detail").click();
    await expect(page).toHaveURL(/\/href\/123/);
    await expect(testId(page, "href-detail-page")).toBeVisible();

    // Navigate back using local href
    await testId(page, "detail-back-link").click();
    await expect(page).toHaveURL(/\/href$/);
    await expect(testId(page, "href-index-page")).toBeVisible();
  });
});
