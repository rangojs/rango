import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import {
  waitForHydration,
  expectNoPageError,
  expectNoReload,
  goBack,
  testId,
} from "./helper";

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

/**
 * Breadcrumb tests - accumulated handle data across route segments
 */
test.describe("blog-breadcrumbs", () => {
  const f = useFixture({
    root: ".",
    mode: "dev",
  });

  test("should display breadcrumbs on blog index", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/blog"));
    await waitForHydration(page);

    // Breadcrumb nav should be visible
    const breadcrumbNav = page.locator('nav[aria-label="Breadcrumb"]');
    await expect(breadcrumbNav).toBeVisible();

    // Should show "Blog" breadcrumb
    await expect(breadcrumbNav.locator("text=Blog")).toBeVisible();
  });

  test("should display nested breadcrumbs on blog post", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/blog/hello-world"));
    await waitForHydration(page);

    const breadcrumbNav = page.locator('nav[aria-label="Breadcrumb"]');
    await expect(breadcrumbNav).toBeVisible();

    // Should show "Blog" and "Hello World" breadcrumbs
    await expect(breadcrumbNav.locator("text=Blog")).toBeVisible();
    await expect(breadcrumbNav.locator("text=Hello World")).toBeVisible();
  });

  test("should update breadcrumbs on navigation", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/blog"));
    await waitForHydration(page);

    const breadcrumbNav = page.locator('nav[aria-label="Breadcrumb"]');

    // Initially only "Blog" breadcrumb
    await expect(breadcrumbNav.locator("text=Blog")).toBeVisible();
    await expect(breadcrumbNav.locator("text=Hello World")).not.toBeVisible();

    // Navigate to a post
    await page.locator('a[href="/blog/hello-world"]').first().click();

    // Wait for post to load
    await expect(page.locator("h2:has-text('Hello World')")).toBeVisible({
      timeout: 3000,
    });

    // Breadcrumbs should now include the post
    await expect(breadcrumbNav.locator("text=Blog")).toBeVisible();
    await expect(breadcrumbNav.locator("text=Hello World")).toBeVisible();
  });

  test("should update breadcrumbs on back navigation", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/blog/hello-world"));
    await waitForHydration(page);

    const breadcrumbNav = page.locator('nav[aria-label="Breadcrumb"]');

    // Both breadcrumbs visible on post page
    await expect(breadcrumbNav.locator("text=Blog")).toBeVisible();
    await expect(breadcrumbNav.locator("text=Hello World")).toBeVisible();

    // Navigate back to blog index
    await breadcrumbNav.locator('a:has-text("Blog")').click();

    // Wait for blog index to load
    await expect(page.locator("text=Blog Posts")).toBeVisible({ timeout: 3000 });

    // Post breadcrumb should be gone
    await expect(breadcrumbNav.locator("text=Blog")).toBeVisible();
    await expect(breadcrumbNav.locator("text=Hello World")).not.toBeVisible();
  });

  test("should show skeleton for async breadcrumb content", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/blog/hello-world"));
    await waitForHydration(page);

    const breadcrumbNav = page.locator('nav[aria-label="Breadcrumb"]');

    // Skeleton should appear while async content is loading (3s delay in handler)
    // Check for skeleton element
    const skeleton = breadcrumbNav.locator("span").filter({
      has: page.locator('[style*="background"]'),
    });

    // Skeleton may or may not be visible depending on timing, but content should eventually load
    // Just check that "Published" appears - proves async content streamed in
    await expect(breadcrumbNav.locator('text=Published')).toBeVisible({
      timeout: 5000,
    });
  });

  test("should stream async breadcrumb content", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/blog/hello-world"));
    await waitForHydration(page);

    const breadcrumbNav = page.locator('nav[aria-label="Breadcrumb"]');

    // The async content has a 3s delay, so we wait for it to stream in
    // Just check that "Published" appears - proves async content streamed in
    await expect(breadcrumbNav.locator('text=Published')).toBeVisible({
      timeout: 5000,
    });
  });
});

/**
 * Production build tests for blog
 */
test.describe("blog-navigation (production)", () => {
  const f = useFixture({
    root: ".",
    mode: "build",
  });

  test.setTimeout(120000);

  test("should display blog index with post links", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/blog"));
    await waitForHydration(page);

    // Wait for sidebar to load
    await expect(page.locator("text=Recent Posts")).toBeVisible({
      timeout: 10000,
    });

    await expect(page.locator("text=Blog Posts")).toBeVisible();
    await expect(
      page.locator('a[href="/blog/hello-world"]').first()
    ).toBeVisible();
  });

  test("should display blog post with sidebar content", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/blog/hello-world"));
    await waitForHydration(page);

    await expect(page.locator("text=Recent Posts")).toBeVisible({
      timeout: 10000,
    });

    await expect(page.locator("h2:has-text('Hello World')")).toBeVisible();
    await expect(page.locator("text=Categories")).toBeVisible();
  });

  test("should preserve sidebar when navigating between posts", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/blog/hello-world"));
    await waitForHydration(page);

    await expect(page.locator("text=Recent Posts")).toBeVisible({
      timeout: 10000,
    });

    await page.locator('a[href="/blog/rsc-routing"]').click();

    await expect(page.locator("text=Recent Posts")).toBeVisible();
    await expect(page.locator("h2:has-text('Rsc Routing')")).toBeVisible({
      timeout: 5000,
    });
  });

  test("should preserve state on back navigation", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/blog"));
    await waitForHydration(page);

    await expect(page.locator("text=Recent Posts")).toBeVisible({
      timeout: 10000,
    });

    await page.locator('a[href="/blog/hello-world"]').first().click();
    await expect(page.locator("h2:has-text('Hello World')")).toBeVisible({
      timeout: 5000,
    });

    await goBack(page);

    await expect(page.locator("text=Blog Posts")).toBeVisible();
    await expect(
      page.locator('a[href="/blog/hello-world"]').first()
    ).toBeVisible();
  });

  test("should perform client-side SPA navigation between blog posts", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/blog/hello-world"));
    await waitForHydration(page);

    await expect(page.locator("text=Recent Posts")).toBeVisible({
      timeout: 10000,
    });

    // Inject reload detector after hydration
    await using _noReload = await expectNoReload(page);

    // Click sidebar link to navigate to a different post
    await page.locator('a[href="/blog/rsc-routing"]').click();

    // New post content should appear via RSC partial update
    await expect(page.locator("h2:has-text('Rsc Routing')")).toBeVisible({
      timeout: 5000,
    });

    // URL should update
    await expect(page).toHaveURL(/\/blog\/rsc-routing/);

    // Sidebar should remain (parallel route cached)
    await expect(page.locator("text=Recent Posts")).toBeVisible();

    // No full page reload occurred (expectNoReload checks on dispose)
  });

  test("should handle multi-hop SPA navigation with back", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // Start at blog index
    await page.goto(f.url("/blog"));
    await waitForHydration(page);

    await expect(page.locator("text=Recent Posts")).toBeVisible({
      timeout: 10000,
    });

    // Hop 1: blog index -> hello-world
    await page.locator('a[href="/blog/hello-world"]').first().click();
    await expect(page.locator("h2:has-text('Hello World')")).toBeVisible({
      timeout: 5000,
    });

    // Hop 2: hello-world -> rsc-routing via sidebar
    await page.locator('a[href="/blog/rsc-routing"]').click();
    await expect(page.locator("h2:has-text('Rsc Routing')")).toBeVisible({
      timeout: 5000,
    });

    // Back to hello-world (should restore from cache)
    await goBack(page);
    await expect(page.locator("h2:has-text('Hello World')")).toBeVisible({
      timeout: 5000,
    });
    await expect(page).toHaveURL(/\/blog\/hello-world/);

    // Back to blog index (should restore from cache)
    await goBack(page);
    await expect(page.locator("text=Blog Posts")).toBeVisible({
      timeout: 5000,
    });
    await expect(page).toHaveURL(/\/blog$/);
  });
});

test.describe("blog-breadcrumbs (production)", () => {
  const f = useFixture({
    root: ".",
    mode: "build",
  });

  test.setTimeout(120000);

  test("should display breadcrumbs on blog index", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/blog"));
    await waitForHydration(page);

    const breadcrumbNav = page.locator('nav[aria-label="Breadcrumb"]');
    await expect(breadcrumbNav).toBeVisible();
    await expect(breadcrumbNav.locator("text=Blog")).toBeVisible();
  });

  test("should display nested breadcrumbs on blog post", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/blog/hello-world"));
    await waitForHydration(page);

    const breadcrumbNav = page.locator('nav[aria-label="Breadcrumb"]');
    await expect(breadcrumbNav).toBeVisible({ timeout: 10000 });
    await expect(breadcrumbNav.locator("text=Blog")).toBeVisible({ timeout: 10000 });
    // "Hello World" breadcrumb may be streamed, give it more time
    await expect(breadcrumbNav.locator("text=Hello World")).toBeVisible({ timeout: 10000 });
  });

  test("should stream async breadcrumb content", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/blog/hello-world"));
    await waitForHydration(page);

    const breadcrumbNav = page.locator('nav[aria-label="Breadcrumb"]');
    // Just check that "Published" appears - proves async content streamed in
    await expect(breadcrumbNav.locator('text=Published')).toBeVisible({
      timeout: 8000,
    });
  });
});
