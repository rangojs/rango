import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError, testId } from "./helper";

/**
 * Tests for scoped reverse resolution
 * - Server-side ctx.reverse in route handlers
 * - Client-side href() + useMount()
 * - Local and absolute resolution
 */
test.describe("Scoped Reverse Resolution", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });

  test.describe("Server-side ctx.reverse", () => {
    test("should resolve local route name to correct path", async ({
      page,
    }) => {
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
    test("should resolve mount-relative path to correct URL", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/href"));
      await waitForHydration(page);

      // Client-side href("/", mount) where mount="/href" -> "/href/"
      const clientLocalIndex = testId(page, "client-local-index");
      await expect(clientLocalIndex).toContainText("/href/");
    });

    test("should resolve mount-relative path with dynamic segment", async ({
      page,
    }) => {
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
        "Detail: from-nested",
      );
    });
  });

  test.describe("Handler<'.filtered', routes> with params + search", () => {
    test("should render filtered page with typed params and search", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(
        f.url("/href/filtered/books?q=typescript&page=2&active=true"),
      );
      await waitForHydration(page);

      // Params from route pattern
      await expect(testId(page, "filtered-category")).toContainText(
        "category: books",
      );

      // Search params from typed schema
      await expect(testId(page, "filtered-q")).toContainText("q: typescript");
      await expect(testId(page, "filtered-page")).toContainText("page: 2");
      await expect(testId(page, "filtered-active")).toContainText(
        "active: true",
      );

      // Types should be parsed (number, boolean — not strings)
      await expect(testId(page, "filtered-q-type")).toContainText(
        "q-type: string",
      );
      await expect(testId(page, "filtered-page-type")).toContainText(
        "page-type: number",
      );
      await expect(testId(page, "filtered-active-type")).toContainText(
        "active-type: boolean",
      );
    });

    test("should handle optional search params as undefined", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      // Only required q param, optional page and active omitted
      await page.goto(f.url("/href/filtered/shoes?q=nike"));
      await waitForHydration(page);

      await expect(testId(page, "filtered-category")).toContainText(
        "category: shoes",
      );
      await expect(testId(page, "filtered-q")).toContainText("q: nike");
      await expect(testId(page, "filtered-page")).toContainText(
        "page: undefined",
      );
      await expect(testId(page, "filtered-active")).toContainText(
        "active: undefined",
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
    await expect(testId(page, "server-local-detail")).toContainText(
      "/href/123",
    );
    await expect(testId(page, "server-absolute-blog")).toContainText("/blog");

    // Client-side hrefs (href + useMount)
    await expect(testId(page, "client-local-index")).toContainText("/href/");
    await expect(testId(page, "client-local-detail")).toContainText(
      "/href/from-client",
    );
    await expect(testId(page, "client-absolute-blog")).toContainText("/blog");
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
