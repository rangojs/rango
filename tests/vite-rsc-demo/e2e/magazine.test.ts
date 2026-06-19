import { expect, test } from "@playwright/test";
import { test as devTest, devURL } from "./dev-fixture";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError, goBack } from "./helper";

/**
 * Magazine tests (dev mode) -- Prerender runs as normal handler in dev
 */
devTest.describe("magazine-navigation", () => {
  devTest("should display magazine index", async ({ page, devServerURL }) => {
    using _ = expectNoPageError(page);

    await page.goto(devURL(devServerURL, "/magazine"));
    await waitForHydration(page);

    await expect(page.locator('[data-testid="magazine-index"]')).toBeVisible({
      timeout: 10000,
    });
    await expect(page.locator("h2:has-text('Articles')")).toBeVisible();
  });

  devTest("should display article page", async ({ page, devServerURL }) => {
    using _ = expectNoPageError(page);

    await page.goto(devURL(devServerURL, "/magazine/design-systems"));
    await waitForHydration(page);

    await expect(page.locator('[data-testid="magazine-article"]')).toBeVisible({
      timeout: 10000,
    });
    await expect(page.locator("h2:has-text('Design Systems')")).toBeVisible();
  });

  devTest("should display author page", async ({ page, devServerURL }) => {
    using _ = expectNoPageError(page);

    await page.goto(devURL(devServerURL, "/magazine/author/alice-writer"));
    await waitForHydration(page);

    await expect(page.locator('[data-testid="magazine-author"]')).toBeVisible({
      timeout: 10000,
    });
    await expect(page.locator("h2:has-text('Alice Writer')")).toBeVisible();
  });

  devTest(
    "should display author posts page",
    async ({ page, devServerURL }) => {
      using _ = expectNoPageError(page);

      await page.goto(
        devURL(devServerURL, "/magazine/author/alice-writer/posts"),
      );
      await waitForHydration(page);

      await expect(
        page.locator('[data-testid="magazine-author-posts"]'),
      ).toBeVisible({ timeout: 10000 });
      await expect(
        page.locator("h2:has-text('Articles by Alice Writer')"),
      ).toBeVisible();
    },
  );
});

devTest.describe("magazine-breadcrumbs", () => {
  devTest(
    "should display Magazine breadcrumb on index",
    async ({ page, devServerURL }) => {
      using _ = expectNoPageError(page);

      await page.goto(devURL(devServerURL, "/magazine"));
      await waitForHydration(page);

      const breadcrumbNav = page.locator('nav[aria-label="Breadcrumb"]');
      await expect(breadcrumbNav.locator("text=Magazine")).toBeVisible();
    },
  );

  devTest(
    "should display article breadcrumbs",
    async ({ page, devServerURL }) => {
      using _ = expectNoPageError(page);

      await page.goto(devURL(devServerURL, "/magazine/design-systems"));
      await waitForHydration(page);

      const breadcrumbNav = page.locator('nav[aria-label="Breadcrumb"]');
      await expect(breadcrumbNav.locator("text=Magazine")).toBeVisible();
      await expect(breadcrumbNav.locator("text=Design Systems")).toBeVisible();
    },
  );

  devTest(
    "should display author breadcrumbs",
    async ({ page, devServerURL }) => {
      using _ = expectNoPageError(page);

      await page.goto(devURL(devServerURL, "/magazine/author/alice-writer"));
      await waitForHydration(page);

      const breadcrumbNav = page.locator('nav[aria-label="Breadcrumb"]');
      await expect(breadcrumbNav.locator("text=Magazine")).toBeVisible();
      await expect(breadcrumbNav.locator("text=Alice Writer")).toBeVisible();
    },
  );

  devTest(
    "should display author posts breadcrumbs",
    async ({ page, devServerURL }) => {
      using _ = expectNoPageError(page);

      await page.goto(
        devURL(devServerURL, "/magazine/author/alice-writer/posts"),
      );
      await waitForHydration(page);

      const breadcrumbNav = page.locator('nav[aria-label="Breadcrumb"]');
      await expect(breadcrumbNav.locator("text=Magazine")).toBeVisible();
      await expect(breadcrumbNav.locator("text=Alice Writer")).toBeVisible();
      await expect(breadcrumbNav.locator("text=Articles")).toBeVisible();
    },
  );

  devTest(
    "should handle SPA navigation with breadcrumb updates",
    async ({ page, devServerURL }) => {
      using _ = expectNoPageError(page);
      const breadcrumbNav = page.locator('nav[aria-label="Breadcrumb"]');

      // Step 1: Magazine index
      await page.goto(devURL(devServerURL, "/magazine"));
      await waitForHydration(page);
      await expect(breadcrumbNav.locator("text=Magazine")).toBeVisible();

      // Step 2: Navigate to article
      await page.locator('a[href="/magazine/design-systems"]').first().click();
      await expect(page.locator("h2:has-text('Design Systems')")).toBeVisible({
        timeout: 10000,
      });
      await expect(breadcrumbNav.locator("text=Magazine")).toBeVisible();
      await expect(breadcrumbNav.locator("text=Design Systems")).toBeVisible();

      // Step 3: Navigate to author
      await page
        .locator('a[href="/magazine/author/alice-writer"]')
        .first()
        .click();
      await expect(page.locator("h2:has-text('Alice Writer')")).toBeVisible({
        timeout: 10000,
      });
      await expect(breadcrumbNav.locator("text=Magazine")).toBeVisible();
      await expect(breadcrumbNav.locator("text=Alice Writer")).toBeVisible();
      await expect(
        breadcrumbNav.locator("text=Design Systems"),
      ).not.toBeVisible();

      // Step 4: Navigate to author posts
      await page
        .locator('a[href="/magazine/author/alice-writer/posts"]')
        .first()
        .click();
      await expect(
        page.locator("h2:has-text('Articles by Alice Writer')"),
      ).toBeVisible({ timeout: 10000 });
      await expect(breadcrumbNav.locator("text=Magazine")).toBeVisible();
      await expect(breadcrumbNav.locator("text=Alice Writer")).toBeVisible();
      await expect(breadcrumbNav.locator("text=Articles")).toBeVisible();
    },
  );

  devTest(
    "should preserve breadcrumbs on back navigation",
    async ({ page, devServerURL }) => {
      using _ = expectNoPageError(page);
      const breadcrumbNav = page.locator('nav[aria-label="Breadcrumb"]');

      // Navigate to author posts
      await page.goto(devURL(devServerURL, "/magazine"));
      await waitForHydration(page);

      await page
        .locator('a[href="/magazine/author/alice-writer"]')
        .first()
        .click();
      await expect(page.locator("h2:has-text('Alice Writer')")).toBeVisible({
        timeout: 10000,
      });
      await expect(breadcrumbNav.locator("text=Alice Writer")).toBeVisible();

      // Go back to index
      await goBack(page);
      await expect(page.locator('[data-testid="magazine-index"]')).toBeVisible({
        timeout: 10000,
      });
      await expect(breadcrumbNav.locator("text=Magazine")).toBeVisible();
      await expect(
        breadcrumbNav.locator("text=Alice Writer"),
      ).not.toBeVisible();
    },
  );
});

/**
 * Magazine tests (production build) -- validates pre-rendering
 */
test.describe("magazine-navigation (production)", () => {
  const f = useFixture({
    root: ".",
    mode: "build",
  });

  test.setTimeout(120000);

  test("should display magazine index with breadcrumbs", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/magazine"));
    await waitForHydration(page);

    await expect(page.locator('[data-testid="magazine-index"]')).toBeVisible({
      timeout: 10000,
    });

    const breadcrumbNav = page.locator('nav[aria-label="Breadcrumb"]');
    await expect(breadcrumbNav.locator("text=Magazine")).toBeVisible();
  });

  test("should display article with breadcrumbs", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/magazine/design-systems"));
    await waitForHydration(page);

    await expect(page.locator("h2:has-text('Design Systems')")).toBeVisible({
      timeout: 10000,
    });

    const breadcrumbNav = page.locator('nav[aria-label="Breadcrumb"]');
    await expect(breadcrumbNav.locator("text=Magazine")).toBeVisible();
    await expect(breadcrumbNav.locator("text=Design Systems")).toBeVisible();
  });

  test("should display author page with breadcrumbs", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/magazine/author/alice-writer"));
    await waitForHydration(page);

    await expect(page.locator("h2:has-text('Alice Writer')")).toBeVisible({
      timeout: 10000,
    });

    const breadcrumbNav = page.locator('nav[aria-label="Breadcrumb"]');
    await expect(breadcrumbNav.locator("text=Magazine")).toBeVisible();
    await expect(breadcrumbNav.locator("text=Alice Writer")).toBeVisible();
  });

  test("should display author posts with breadcrumbs", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/magazine/author/alice-writer/posts"));
    await waitForHydration(page);

    await expect(
      page.locator("h2:has-text('Articles by Alice Writer')"),
    ).toBeVisible({ timeout: 10000 });

    const breadcrumbNav = page.locator('nav[aria-label="Breadcrumb"]');
    await expect(breadcrumbNav.locator("text=Magazine")).toBeVisible();
    await expect(breadcrumbNav.locator("text=Alice Writer")).toBeVisible();
    await expect(breadcrumbNav.locator("text=Articles")).toBeVisible();
  });

  test("should handle SPA navigation with breadcrumb updates in production", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    const breadcrumbNav = page.locator('nav[aria-label="Breadcrumb"]');

    // Start at index
    await page.goto(f.url("/magazine"));
    await waitForHydration(page);
    await expect(breadcrumbNav.locator("text=Magazine")).toBeVisible();

    // Navigate to article
    await page.locator('a[href="/magazine/design-systems"]').first().click();
    await expect(page.locator("h2:has-text('Design Systems')")).toBeVisible({
      timeout: 10000,
    });
    await expect(breadcrumbNav.locator("text=Design Systems")).toBeVisible();

    // Navigate to author
    await page
      .locator('a[href="/magazine/author/alice-writer"]')
      .first()
      .click();
    await expect(page.locator("h2:has-text('Alice Writer')")).toBeVisible({
      timeout: 10000,
    });
    await expect(breadcrumbNav.locator("text=Alice Writer")).toBeVisible();

    // Navigate to author posts
    await page
      .locator('a[href="/magazine/author/alice-writer/posts"]')
      .first()
      .click();
    await expect(
      page.locator("h2:has-text('Articles by Alice Writer')"),
    ).toBeVisible({ timeout: 10000 });
    await expect(breadcrumbNav.locator("text=Articles")).toBeVisible();
  });

  test("should preserve breadcrumbs on back navigation in production", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    const breadcrumbNav = page.locator('nav[aria-label="Breadcrumb"]');

    await page.goto(f.url("/magazine"));
    await waitForHydration(page);

    // Navigate to author
    await page
      .locator('a[href="/magazine/author/alice-writer"]')
      .first()
      .click();
    await expect(page.locator("h2:has-text('Alice Writer')")).toBeVisible({
      timeout: 10000,
    });

    // Go back
    await goBack(page);
    await expect(page.locator('[data-testid="magazine-index"]')).toBeVisible({
      timeout: 10000,
    });
    await expect(breadcrumbNav.locator("text=Magazine")).toBeVisible();
    await expect(breadcrumbNav.locator("text=Alice Writer")).not.toBeVisible();
  });
});

/**
 * Magazine breadcrumb tests (production build) -- mirrors the dev
 * magazine-breadcrumbs describe against the pre-rendered build output.
 */
test.describe("magazine-breadcrumbs (production)", () => {
  const f = useFixture({
    root: ".",
    mode: "build",
  });

  test.setTimeout(120000);

  test("should display Magazine breadcrumb on index", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/magazine"));
    await waitForHydration(page);

    const breadcrumbNav = page.locator('nav[aria-label="Breadcrumb"]');
    await expect(breadcrumbNav.locator("text=Magazine")).toBeVisible();
  });

  test("should display article breadcrumbs", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/magazine/design-systems"));
    await waitForHydration(page);

    const breadcrumbNav = page.locator('nav[aria-label="Breadcrumb"]');
    await expect(breadcrumbNav.locator("text=Magazine")).toBeVisible();
    await expect(breadcrumbNav.locator("text=Design Systems")).toBeVisible();
  });

  test("should display author breadcrumbs", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/magazine/author/alice-writer"));
    await waitForHydration(page);

    const breadcrumbNav = page.locator('nav[aria-label="Breadcrumb"]');
    await expect(breadcrumbNav.locator("text=Magazine")).toBeVisible();
    await expect(breadcrumbNav.locator("text=Alice Writer")).toBeVisible();
  });

  test("should display author posts breadcrumbs", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/magazine/author/alice-writer/posts"));
    await waitForHydration(page);

    const breadcrumbNav = page.locator('nav[aria-label="Breadcrumb"]');
    await expect(breadcrumbNav.locator("text=Magazine")).toBeVisible();
    await expect(breadcrumbNav.locator("text=Alice Writer")).toBeVisible();
    await expect(breadcrumbNav.locator("text=Articles")).toBeVisible();
  });

  test("should handle SPA navigation with breadcrumb updates", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    const breadcrumbNav = page.locator('nav[aria-label="Breadcrumb"]');

    // Step 1: Magazine index
    await page.goto(f.url("/magazine"));
    await waitForHydration(page);
    await expect(breadcrumbNav.locator("text=Magazine")).toBeVisible();

    // Step 2: Navigate to article
    await page.locator('a[href="/magazine/design-systems"]').first().click();
    await expect(page.locator("h2:has-text('Design Systems')")).toBeVisible({
      timeout: 10000,
    });
    await expect(breadcrumbNav.locator("text=Magazine")).toBeVisible();
    await expect(breadcrumbNav.locator("text=Design Systems")).toBeVisible();

    // Step 3: Navigate to author
    await page
      .locator('a[href="/magazine/author/alice-writer"]')
      .first()
      .click();
    await expect(page.locator("h2:has-text('Alice Writer')")).toBeVisible({
      timeout: 10000,
    });
    await expect(breadcrumbNav.locator("text=Magazine")).toBeVisible();
    await expect(breadcrumbNav.locator("text=Alice Writer")).toBeVisible();
    await expect(
      breadcrumbNav.locator("text=Design Systems"),
    ).not.toBeVisible();

    // Step 4: Navigate to author posts
    await page
      .locator('a[href="/magazine/author/alice-writer/posts"]')
      .first()
      .click();
    await expect(
      page.locator("h2:has-text('Articles by Alice Writer')"),
    ).toBeVisible({ timeout: 10000 });
    await expect(breadcrumbNav.locator("text=Magazine")).toBeVisible();
    await expect(breadcrumbNav.locator("text=Alice Writer")).toBeVisible();
    await expect(breadcrumbNav.locator("text=Articles")).toBeVisible();
  });

  test("should preserve breadcrumbs on back navigation", async ({ page }) => {
    using _ = expectNoPageError(page);
    const breadcrumbNav = page.locator('nav[aria-label="Breadcrumb"]');

    await page.goto(f.url("/magazine"));
    await waitForHydration(page);

    await page
      .locator('a[href="/magazine/author/alice-writer"]')
      .first()
      .click();
    await expect(page.locator("h2:has-text('Alice Writer')")).toBeVisible({
      timeout: 10000,
    });
    await expect(breadcrumbNav.locator("text=Alice Writer")).toBeVisible();

    await goBack(page);
    await expect(page.locator('[data-testid="magazine-index"]')).toBeVisible({
      timeout: 10000,
    });
    await expect(breadcrumbNav.locator("text=Magazine")).toBeVisible();
    await expect(breadcrumbNav.locator("text=Alice Writer")).not.toBeVisible();
  });
});
