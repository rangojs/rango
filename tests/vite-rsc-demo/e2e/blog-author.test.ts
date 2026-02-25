import { expect, test } from "@playwright/test";
import { test as devTest, devURL } from "./dev-fixture";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError, goBack } from "./helper";

/**
 * Blog author intercept tests (dev mode)
 */
devTest.describe("blog-author-intercept", () => {
  devTest(
    "should show author modal when clicking author from blog index",
    async ({ page, devServerURL }) => {
      using _ = expectNoPageError(page);

      await page.goto(devURL(devServerURL, "/blog"));
      await waitForHydration(page);

      // Click author link on blog index
      await page.locator('a[href="/blog/author/jane-doe"]').first().click();

      // Should show intercept modal
      await expect(page.locator("text=Intercepted")).toBeVisible({
        timeout: 5000,
      });

      // Background blog content should remain visible
      await expect(page.locator("text=Blog Posts")).toBeVisible();
    },
  );

  devTest(
    "should navigate directly to author page from a post",
    async ({ page, devServerURL }) => {
      using _ = expectNoPageError(page);

      await page.goto(devURL(devServerURL, "/blog/hello-world"));
      await waitForHydration(page);

      // Wait for post to render
      await expect(page.locator("h2:has-text('Hello World')")).toBeVisible({
        timeout: 5000,
      });

      // Click author link on post page
      await page.locator('a[href="/blog/author/jane-doe"]').first().click();

      // Should NOT be intercepted (when() returns false from post pages)
      await expect(page.locator("text=Intercepted")).not.toBeVisible({
        timeout: 3000,
      });

      // Should show full author page
      await expect(page.locator('[data-testid="author-page"]')).toBeVisible({
        timeout: 5000,
      });
      await expect(page.locator("h2:has-text('Jane Doe')")).toBeVisible();
    },
  );

  devTest(
    "should close author modal on back navigation",
    async ({ page, devServerURL }) => {
      using _ = expectNoPageError(page);

      await page.goto(devURL(devServerURL, "/blog"));
      await waitForHydration(page);

      // Open modal
      await page.locator('a[href="/blog/author/jane-doe"]').first().click();
      await expect(page.locator("text=Intercepted")).toBeVisible({
        timeout: 5000,
      });

      // Go back
      await goBack(page);

      // Modal should be gone
      await expect(page.locator("text=Intercepted")).not.toBeVisible({
        timeout: 3000,
      });

      // Blog index should be restored
      await expect(page.locator("text=Blog Posts")).toBeVisible();
    },
  );

  devTest(
    "should navigate from author modal to full author page",
    async ({ page, devServerURL }) => {
      using _ = expectNoPageError(page);

      await page.goto(devURL(devServerURL, "/blog"));
      await waitForHydration(page);

      // Open modal
      await page.locator('a[href="/blog/author/jane-doe"]').first().click();
      await expect(page.locator("text=Intercepted")).toBeVisible({
        timeout: 5000,
      });

      // Click "View Full Details"
      await page.locator("text=View Full Details").click();
      await expect(page.locator("text=Intercepted")).not.toBeVisible({
        timeout: 3000,
      });

      // Full author page should be visible
      await expect(page.locator('[data-testid="author-page"]')).toBeVisible({
        timeout: 5000,
      });
      await expect(page.locator("h2:has-text('Jane Doe')")).toBeVisible();
    },
  );
});

/**
 * Blog author breadcrumb tests (dev mode)
 */
devTest.describe("blog-author-breadcrumbs", () => {
  devTest(
    "should display correct breadcrumbs on author page (direct nav)",
    async ({ page, devServerURL }) => {
      using _ = expectNoPageError(page);

      await page.goto(devURL(devServerURL, "/blog/author/jane-doe"));
      await waitForHydration(page);

      await expect(page.locator("h2:has-text('Jane Doe')")).toBeVisible({
        timeout: 5000,
      });

      const breadcrumbNav = page.locator('nav[aria-label="Breadcrumb"]');
      await expect(breadcrumbNav.locator("text=Blog")).toBeVisible();
      await expect(breadcrumbNav.locator("text=Jane Doe")).toBeVisible();
    },
  );

  devTest(
    "should display correct breadcrumbs on author posts page",
    async ({ page, devServerURL }) => {
      using _ = expectNoPageError(page);

      await page.goto(devURL(devServerURL, "/blog/author/jane-doe/posts"));
      await waitForHydration(page);

      await expect(
        page.locator("h2:has-text('Posts by Jane Doe')"),
      ).toBeVisible({ timeout: 5000 });

      const breadcrumbNav = page.locator('nav[aria-label="Breadcrumb"]');
      await expect(breadcrumbNav.locator("text=Blog")).toBeVisible();
      await expect(breadcrumbNav.locator("text=Jane Doe")).toBeVisible();
      await expect(breadcrumbNav.locator("text=Posts")).toBeVisible();
    },
  );

  devTest(
    "should stream async breadcrumb content on author page",
    async ({ page, devServerURL }) => {
      using _ = expectNoPageError(page);

      await page.goto(devURL(devServerURL, "/blog/author/jane-doe"));
      await waitForHydration(page);

      await expect(page.locator("h2:has-text('Jane Doe')")).toBeVisible({
        timeout: 5000,
      });

      // The async breadcrumb content "(2 posts)" streams in after 2s delay
      const breadcrumbNav = page.locator('nav[aria-label="Breadcrumb"]');
      await expect(breadcrumbNav.locator("text=Jane Doe")).toBeVisible();

      // Initially might show skeleton, then content streams in
      await expect(breadcrumbNav.locator("text=(2 posts)")).toBeVisible({
        timeout: 5000,
      });
    },
  );

  devTest(
    "should update breadcrumbs through deep navigation: index -> post -> author -> posts",
    async ({ page, devServerURL }) => {
      using _ = expectNoPageError(page);
      const breadcrumbNav = page.locator('nav[aria-label="Breadcrumb"]');

      // Step 1: Blog index
      await page.goto(devURL(devServerURL, "/blog"));
      await waitForHydration(page);
      await expect(breadcrumbNav.locator("text=Blog")).toBeVisible();

      // Step 2: Navigate to post
      await page.locator('a[href="/blog/hello-world"]').first().click();
      await expect(page.locator("h2:has-text('Hello World')")).toBeVisible({
        timeout: 5000,
      });
      await expect(breadcrumbNav.locator("text=Blog")).toBeVisible();
      await expect(breadcrumbNav.locator("text=Hello World")).toBeVisible();

      // Step 3: Navigate to author (direct from post - no intercept)
      await page.locator('a[href="/blog/author/jane-doe"]').first().click();
      await expect(page.locator("h2:has-text('Jane Doe')")).toBeVisible({
        timeout: 5000,
      });
      await expect(breadcrumbNav.locator("text=Blog")).toBeVisible();
      await expect(breadcrumbNav.locator("text=Jane Doe")).toBeVisible();
      // Post breadcrumb should be gone
      await expect(breadcrumbNav.locator("text=Hello World")).not.toBeVisible();

      // Step 4: Navigate to author posts
      await page
        .locator('a[href="/blog/author/jane-doe/posts"]')
        .first()
        .click();
      await expect(
        page.locator("h2:has-text('Posts by Jane Doe')"),
      ).toBeVisible({ timeout: 5000 });
      await expect(breadcrumbNav.locator("text=Blog")).toBeVisible();
      await expect(breadcrumbNav.locator("text=Jane Doe")).toBeVisible();
      await expect(breadcrumbNav.locator("text=Posts")).toBeVisible();
    },
  );

  devTest(
    "should update breadcrumbs when navigating from modal to full author page",
    async ({ page, devServerURL }) => {
      using _ = expectNoPageError(page);
      const breadcrumbNav = page.locator('nav[aria-label="Breadcrumb"]');

      // Start at blog index
      await page.goto(devURL(devServerURL, "/blog"));
      await waitForHydration(page);

      // Open author modal from index
      await page.locator('a[href="/blog/author/jane-doe"]').first().click();
      await expect(page.locator("text=Intercepted")).toBeVisible({
        timeout: 5000,
      });

      // Navigate to full author page
      await page.locator("text=View Full Details").click();
      await expect(page.locator("text=Intercepted")).not.toBeVisible({
        timeout: 3000,
      });
      await expect(page.locator("h2:has-text('Jane Doe')")).toBeVisible({
        timeout: 10000,
      });

      // Breadcrumbs should show Blog / Jane Doe
      await expect(breadcrumbNav.locator("text=Blog")).toBeVisible();
      await expect(breadcrumbNav.locator("text=Jane Doe")).toBeVisible();
    },
  );
});

/**
 * Blog author tests (production build)
 */
test.describe("blog-author-breadcrumbs (production)", () => {
  const f = useFixture({
    root: ".",
    mode: "build",
  });

  test.setTimeout(120000);

  test("should display correct breadcrumbs on author page", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/blog/author/jane-doe"));
    await waitForHydration(page);

    await expect(page.locator("h2:has-text('Jane Doe')")).toBeVisible({
      timeout: 10000,
    });

    const breadcrumbNav = page.locator('nav[aria-label="Breadcrumb"]');
    await expect(breadcrumbNav.locator("text=Blog")).toBeVisible();
    await expect(breadcrumbNav.locator("text=Jane Doe")).toBeVisible();
  });

  test("should display correct breadcrumbs on author posts page", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/blog/author/jane-doe/posts"));
    await waitForHydration(page);

    await expect(page.locator("h2:has-text('Posts by Jane Doe')")).toBeVisible({
      timeout: 10000,
    });

    const breadcrumbNav = page.locator('nav[aria-label="Breadcrumb"]');
    await expect(breadcrumbNav.locator("text=Blog")).toBeVisible();
    await expect(breadcrumbNav.locator("text=Jane Doe")).toBeVisible();
    await expect(breadcrumbNav.locator("text=Posts")).toBeVisible();
  });

  test("should show author modal from index in production", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/blog"));
    await waitForHydration(page);

    await page.locator('a[href="/blog/author/jane-doe"]').first().click();
    await expect(page.locator("text=Intercepted")).toBeVisible({
      timeout: 5000,
    });
  });

  test("should navigate directly to author from post in production", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/blog/hello-world"));
    await waitForHydration(page);

    await expect(page.locator("h2:has-text('Hello World')")).toBeVisible({
      timeout: 10000,
    });

    await page.locator('a[href="/blog/author/jane-doe"]').first().click();
    await expect(page.locator("text=Intercepted")).not.toBeVisible({
      timeout: 3000,
    });
    await expect(page.locator("h2:has-text('Jane Doe')")).toBeVisible({
      timeout: 10000,
    });
  });
});
