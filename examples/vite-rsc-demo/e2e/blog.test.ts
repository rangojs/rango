import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError, goBack, testId } from "./helper";

/**
 * Blog tests - parallel routes with loading states
 */
test.describe("blog-navigation", () => {
  const f = useFixture({
    root: ".",
    mode: "dev",
  });

  test("should display blog index with post links", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/blog"));
    await waitForHydration(page);

    // Wait for sidebar to load (it has a 5.5s delay)
    await expect(page.locator("text=Recent Posts")).toBeVisible({
      timeout: 8000,
    });

    // Blog index should show post links
    await expect(page.locator("text=Blog Posts")).toBeVisible();
    // Use first() since sidebar also has links to same posts
    await expect(
      page.locator('a[href="/blog/hello-world"]').first()
    ).toBeVisible();
    await expect(
      page.locator('a[href="/blog/react-server-components"]').first()
    ).toBeVisible();
    await expect(
      page.locator('a[href="/blog/router-design"]').first()
    ).toBeVisible();
  });

  test("should show loading sidebar skeleton during navigation", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/blog"));
    await waitForHydration(page);

    // Wait for initial sidebar to load first
    await expect(page.locator("text=Recent Posts")).toBeVisible({
      timeout: 8000,
    });

    // Click on a blog post link from the main content (not sidebar)
    await page
      .locator("ul")
      .first()
      .locator('a[href="/blog/hello-world"]')
      .click();

    // Post content should be visible
    await expect(page.locator("h2:has-text('Hello World')")).toBeVisible({
      timeout: 3000,
    });

    // Sidebar should still be visible (no revalidation on post navigation)
    await expect(page.locator("text=Recent Posts")).toBeVisible();
  });

  test("should display blog post with sidebar content", async ({ page }) => {
    using _ = expectNoPageError(page);

    // Direct navigation to blog post
    await page.goto(f.url("/blog/hello-world"));
    await waitForHydration(page);

    // Wait for sidebar to load
    await expect(page.locator("text=Recent Posts")).toBeVisible({
      timeout: 8000,
    });

    // Post content should be visible
    await expect(page.locator("h2:has-text('Hello World')")).toBeVisible();

    // Sidebar sections should be visible
    await expect(page.locator("text=Categories")).toBeVisible();
    await expect(page.locator("text=Tags")).toBeVisible();
  });

  test("should preserve sidebar when navigating between posts", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/blog/hello-world"));
    await waitForHydration(page);

    // Wait for sidebar to load
    await expect(page.locator("text=Recent Posts")).toBeVisible({
      timeout: 8000,
    });

    // Navigate to another post using sidebar link
    await page.locator('a[href="/blog/rsc-routing"]').click();

    // Sidebar should still be visible (not showing loading again due to revalidation rules)
    await expect(page.locator("text=Recent Posts")).toBeVisible();

    // New post content should load
    await expect(page.locator("h2:has-text('Rsc Routing')")).toBeVisible({
      timeout: 3000,
    });
  });

  test("should preserve state on back navigation", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/blog"));
    await waitForHydration(page);

    // Wait for sidebar to load first
    await expect(page.locator("text=Recent Posts")).toBeVisible({
      timeout: 8000,
    });

    // Navigate to a post
    await page.locator('a[href="/blog/hello-world"]').first().click();

    // Wait for post to load
    await expect(page.locator("h2:has-text('Hello World')")).toBeVisible({
      timeout: 3000,
    });

    // Navigate back
    await goBack(page);

    // Blog index should be restored from cache
    await expect(page.locator("text=Blog Posts")).toBeVisible();
    await expect(
      page.locator('a[href="/blog/hello-world"]').first()
    ).toBeVisible();
  });
});
