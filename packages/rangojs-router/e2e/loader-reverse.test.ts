import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError, testId } from "./helper";

/**
 * Tests for ctx.reverse inside loaders.
 * Verifies that loaders can use the same scoped reverse function as handlers,
 * including both global route names and dot-prefixed local names.
 *
 * Three categories:
 * 1. Server-consumed loaders (ctx.use) — non-fetchable loaders read on the server
 * 2. Client-bound loaders (useLoader) — fetchable loaders passed to client components
 * 3. Client-fetched loaders (useFetchLoader + load()) — exercises the loader-fetch.ts
 *    path where the loader runs via _rsc_loader GET, not via RSC rendering
 */
test.describe("Loader ctx.reverse", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });

  test.describe("server-consumed loaders (ctx.use)", () => {
    test("should resolve global route names", async ({ page }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/loader-reverse"));
      await waitForHydration(page);

      await expect(testId(page, "loader-reverse-page")).toBeVisible();

      // Global route: blog.index -> /blog
      await expect(testId(page, "loader-global-blog-index")).toContainText(
        "/blog",
      );

      // Global route with params: blog.post { postId: "from-loader" } -> /blog/from-loader
      await expect(testId(page, "loader-global-blog-post")).toContainText(
        "/blog/from-loader",
      );

      // Global route: href.index -> /href
      await expect(testId(page, "loader-global-href-index")).toContainText(
        "/href",
      );
    });

    test("should resolve scoped .name route names within include() scope", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/loader-reverse"));
      await waitForHydration(page);

      // Scoped .index -> /loader-reverse
      await expect(testId(page, "loader-scoped-index")).toContainText(
        "/loader-reverse",
      );

      // Scoped .detail with params -> /loader-reverse/from-scoped-loader
      await expect(testId(page, "loader-scoped-detail")).toContainText(
        "/loader-reverse/from-scoped-loader",
      );

      // Global blog.index from scoped loader -> /blog
      await expect(testId(page, "loader-scoped-global-blog")).toContainText(
        "/blog",
      );
    });
  });

  test.describe("client-bound loaders (useLoader)", () => {
    test("should resolve global route names via useLoader", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/loader-reverse"));
      await waitForHydration(page);

      await expect(testId(page, "client-loader-global-section")).toBeVisible();

      // Global route: blog.index -> /blog
      await expect(
        testId(page, "client-loader-global-blog-index"),
      ).toContainText("/blog");

      // Global route with params: blog.post { postId: "from-client-loader" } -> /blog/from-client-loader
      await expect(
        testId(page, "client-loader-global-blog-post"),
      ).toContainText("/blog/from-client-loader");

      // Global route: href.index -> /href
      await expect(
        testId(page, "client-loader-global-href-index"),
      ).toContainText("/href");
    });

    test("should resolve scoped .name route names via useLoader", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/loader-reverse"));
      await waitForHydration(page);

      await expect(testId(page, "client-loader-scoped-section")).toBeVisible();

      // Scoped .index -> /loader-reverse
      await expect(testId(page, "client-loader-scoped-index")).toContainText(
        "/loader-reverse",
      );

      // Scoped .detail with params -> /loader-reverse/from-client-scoped-loader
      await expect(testId(page, "client-loader-scoped-detail")).toContainText(
        "/loader-reverse/from-client-scoped-loader",
      );

      // Global blog.index from scoped loader -> /blog
      await expect(
        testId(page, "client-loader-scoped-global-blog"),
      ).toContainText("/blog");
    });
  });

  test.describe("client-fetched loaders (useFetchLoader + load())", () => {
    test("should resolve scoped .name after client-side refetch via _rsc_loader", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/loader-reverse"));
      await waitForHydration(page);

      // Initial SSR data should be present
      await expect(testId(page, "fetch-loader-scoped-section")).toBeVisible();
      const initialCount = await testId(
        page,
        "fetch-loader-scoped-count",
      ).textContent();

      // Click refetch to trigger _rsc_loader GET request (loader-fetch.ts path)
      await testId(page, "fetch-loader-refetch").click();

      // Wait for count to change (proves data came from a new server fetch)
      await expect(testId(page, "fetch-loader-scoped-count")).not.toHaveText(
        initialCount!,
      );

      // Verify scoped reverse still resolves correctly via the loader-fetch path
      await expect(testId(page, "fetch-loader-scoped-index")).toContainText(
        "/loader-reverse",
      );
      await expect(testId(page, "fetch-loader-scoped-detail")).toContainText(
        "/loader-reverse/from-fetch-scoped-loader",
      );
      await expect(
        testId(page, "fetch-loader-scoped-global-blog"),
      ).toContainText("/blog");
    });
  });
});

test.describe("Loader ctx.reverse (production)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "build",
  });

  test.describe("server-consumed loaders (ctx.use)", () => {
    test("should resolve all reverse types correctly in production build", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/loader-reverse"));
      await waitForHydration(page);

      await expect(testId(page, "loader-reverse-page")).toBeVisible();

      // Global reverse from loader
      await expect(testId(page, "loader-global-blog-index")).toContainText(
        "/blog",
      );
      await expect(testId(page, "loader-global-blog-post")).toContainText(
        "/blog/from-loader",
      );
      await expect(testId(page, "loader-global-href-index")).toContainText(
        "/href",
      );

      // Scoped reverse from loader
      await expect(testId(page, "loader-scoped-index")).toContainText(
        "/loader-reverse",
      );
      await expect(testId(page, "loader-scoped-detail")).toContainText(
        "/loader-reverse/from-scoped-loader",
      );
      await expect(testId(page, "loader-scoped-global-blog")).toContainText(
        "/blog",
      );
    });
  });

  test.describe("client-bound loaders (useLoader)", () => {
    test("should resolve global route names via useLoader in production", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/loader-reverse"));
      await waitForHydration(page);

      await expect(testId(page, "client-loader-global-section")).toBeVisible();

      await expect(
        testId(page, "client-loader-global-blog-index"),
      ).toContainText("/blog");
      await expect(
        testId(page, "client-loader-global-blog-post"),
      ).toContainText("/blog/from-client-loader");
      await expect(
        testId(page, "client-loader-global-href-index"),
      ).toContainText("/href");
    });

    test("should resolve scoped .name route names via useLoader in production", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/loader-reverse"));
      await waitForHydration(page);

      await expect(testId(page, "client-loader-scoped-section")).toBeVisible();

      await expect(testId(page, "client-loader-scoped-index")).toContainText(
        "/loader-reverse",
      );
      await expect(testId(page, "client-loader-scoped-detail")).toContainText(
        "/loader-reverse/from-client-scoped-loader",
      );
      await expect(
        testId(page, "client-loader-scoped-global-blog"),
      ).toContainText("/blog");
    });
  });

  test.describe("client-fetched loaders (useFetchLoader + load())", () => {
    test("should resolve scoped .name after client-side refetch via _rsc_loader in production", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/loader-reverse"));
      await waitForHydration(page);

      await expect(testId(page, "fetch-loader-scoped-section")).toBeVisible();
      const initialCount = await testId(
        page,
        "fetch-loader-scoped-count",
      ).textContent();

      // Click refetch to trigger _rsc_loader GET request
      await testId(page, "fetch-loader-refetch").click();

      // Wait for count to change (proves data came from a new server fetch)
      await expect(testId(page, "fetch-loader-scoped-count")).not.toHaveText(
        initialCount!,
      );

      // Verify scoped reverse resolves correctly via the loader-fetch path
      await expect(testId(page, "fetch-loader-scoped-index")).toContainText(
        "/loader-reverse",
      );
      await expect(testId(page, "fetch-loader-scoped-detail")).toContainText(
        "/loader-reverse/from-fetch-scoped-loader",
      );
      await expect(
        testId(page, "fetch-loader-scoped-global-blog"),
      ).toContainText("/blog");
    });
  });
});
