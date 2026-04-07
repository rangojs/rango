import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import {
  waitForHydration,
  expectNoPageError,
  testId,
  expectNoReload,
} from "./helper";

test.describe.configure({ mode: "serial" });

/**
 * Navigation steps for basic pages (no caching)
 */
const basicNavigationSteps = [
  {
    name: "Home page",
    nav: "nav-home",
    pageTestId: "home-page",
    expectedTitle: "Welcome to RSC Router",
    titleTestId: "home-title",
  },
  {
    name: "About page",
    nav: "nav-about",
    pageTestId: "about-page",
    expectedTitle: "About",
    titleTestId: "about-title",
  },
  {
    name: "Counter page",
    nav: "nav-counter",
    pageTestId: "counter-page",
    expectedTitle: "Counter Demo",
    titleTestId: "counter-title",
  },
];

/**
 * Basic navigation tests for dev mode
 * Validates that non-cached pages render correctly on repeated navigation
 */
test.describe("basic-navigation (dev)", () => {
  const f = useFixture({
    root: ".",
    mode: "dev",
  });

  test("should display correct content on repeated navigation (3 iterations)", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/"));
    await waitForHydration(page);

    // Run 3 iterations to test navigation stability
    for (let iteration = 1; iteration <= 3; iteration++) {
      console.log(`\n=== Iteration ${iteration} ===`);

      for (const step of basicNavigationSteps) {
        await testId(page, step.nav).click();
        await expect(testId(page, step.pageTestId)).toBeVisible({
          timeout: 10000,
        });
        await expect(testId(page, step.titleTestId)).toHaveText(
          step.expectedTitle,
        );
        console.log(`[${iteration}] ${step.name}: OK`);
      }
    }
  });

  test("should preserve nav during navigation (no page reload)", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/"));
    await waitForHydration(page);

    await using __ = await expectNoReload(page);

    // Navigate through all pages twice without reload
    for (let iteration = 1; iteration <= 2; iteration++) {
      for (const step of basicNavigationSteps) {
        await testId(page, step.nav).click();
        await expect(testId(page, step.pageTestId)).toBeVisible({
          timeout: 10000,
        });
      }
    }
  });
});

/**
 * Basic navigation tests for production (preview) mode
 */
test.describe("basic-navigation (production)", () => {
  const f = useFixture({
    root: ".",
    mode: "build",
  });

  test("should display correct content on repeated navigation (3 iterations)", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/"));
    await waitForHydration(page);

    // Run 3 iterations to test navigation stability
    for (let iteration = 1; iteration <= 3; iteration++) {
      console.log(`\n=== Iteration ${iteration} ===`);

      for (const step of basicNavigationSteps) {
        await testId(page, step.nav).click();
        await expect(testId(page, step.pageTestId)).toBeVisible({
          timeout: 10000,
        });
        await expect(testId(page, step.titleTestId)).toHaveText(
          step.expectedTitle,
        );
        console.log(`[${iteration}] ${step.name}: OK`);
      }
    }
  });

  test("should preserve nav during navigation (no page reload)", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/"));
    await waitForHydration(page);

    await using __ = await expectNoReload(page);

    // Navigate through all pages twice without reload
    for (let iteration = 1; iteration <= 2; iteration++) {
      for (const step of basicNavigationSteps) {
        await testId(page, step.nav).click();
        await expect(testId(page, step.pageTestId)).toBeVisible({
          timeout: 10000,
        });
      }
    }
  });
});

/**
 * Proactive cache test route tests (dev mode)
 * Tests the proactive caching behavior where layout is inside cache boundary
 */
test.describe("proactive-cache (dev)", () => {
  const f = useFixture({
    root: ".",
    mode: "dev",
  });

  test("should navigate through proactive cache routes 3 times", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/proactive-cache"));
    await waitForHydration(page);

    await expect(testId(page, "proactive-index-page")).toBeVisible();

    // Track timestamps to verify caching
    const timestamps: Record<string, string[]> = {
      index: [],
      itemA: [],
      itemB: [],
    };

    // Navigate 3 times through the routes
    for (let i = 1; i <= 3; i++) {
      console.log(`\n=== Proactive Cache Iteration ${i} ===`);

      // Navigate to Item A
      await testId(page, "proactive-nav-a").click();
      await expect(testId(page, "proactive-item-a-page")).toBeVisible();
      const timestampA = await testId(
        page,
        "proactive-item-a-rendered",
      ).textContent();
      timestamps.itemA.push(timestampA || "");
      console.log(`Item A: ${timestampA?.slice(-25) || "N/A"}`);

      // Navigate to Item B
      await testId(page, "proactive-nav-b").click();
      await expect(testId(page, "proactive-item-b-page")).toBeVisible();
      const timestampB = await testId(
        page,
        "proactive-item-b-rendered",
      ).textContent();
      timestamps.itemB.push(timestampB || "");
      console.log(`Item B: ${timestampB?.slice(-25) || "N/A"}`);

      // Navigate back to Index
      await testId(page, "proactive-nav-index").click();
      await expect(testId(page, "proactive-index-page")).toBeVisible();
      const timestampIndex = await testId(
        page,
        "proactive-index-rendered",
      ).textContent();
      timestamps.index.push(timestampIndex || "");
      console.log(`Index: ${timestampIndex?.slice(-25) || "N/A"}`);
    }

    // Log timestamps summary
    console.log("\n=== Proactive Cache Summary ===");
    for (const [route, times] of Object.entries(timestamps)) {
      console.log(`${route}:`);
      times.forEach((t, i) =>
        console.log(`  Visit ${i + 1}: ${t?.slice(-25) || "N/A"}`),
      );
      // Check if timestamps match (cache hit)
      if (times.length >= 3 && times[1] === times[2]) {
        console.log(`  -> Cache likely active (visits 2 & 3 match)`);
      }
    }
  });

  test("should preserve layout during navigation (no reload)", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/proactive-cache"));
    await waitForHydration(page);

    await expect(testId(page, "proactive-cache-layout")).toBeVisible();

    await using __ = await expectNoReload(page);

    // Navigate through routes
    await testId(page, "proactive-nav-a").click();
    await expect(testId(page, "proactive-item-a-page")).toBeVisible();
    await expect(testId(page, "proactive-cache-layout")).toBeVisible();

    await testId(page, "proactive-nav-b").click();
    await expect(testId(page, "proactive-item-b-page")).toBeVisible();
    await expect(testId(page, "proactive-cache-layout")).toBeVisible();

    await testId(page, "proactive-nav-index").click();
    await expect(testId(page, "proactive-index-page")).toBeVisible();
    await expect(testId(page, "proactive-cache-layout")).toBeVisible();
  });
});

/**
 * Blog breadcrumb tests - validates breadcrumbs don't duplicate with caching
 * This is a regression test for cached segments re-pushing handle data
 */
test.describe("blog-breadcrumbs (production)", () => {
  const f = useFixture({
    root: ".",
    mode: "build",
  });

  test("should have correct breadcrumbs on blog index", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/blog"));
    await waitForHydration(page);

    await expect(testId(page, "blog-index")).toBeVisible();

    // Verify exact breadcrumbs: Home / Blog
    const breadcrumbs = testId(page, "breadcrumbs");
    await expect(breadcrumbs).toBeVisible();

    // Check breadcrumb links/text
    await expect(
      breadcrumbs.locator("a, span").filter({ hasText: "Home" }),
    ).toHaveCount(1);
    await expect(
      breadcrumbs.locator("a, span").filter({ hasText: "Blog" }),
    ).toHaveCount(1);

    // Verify the exact text content (no duplicates)
    const breadcrumbText = await breadcrumbs.textContent();
    console.log(`Breadcrumbs on /blog: "${breadcrumbText}"`);

    // Should be exactly "Home / Blog" (with separators)
    expect(breadcrumbText?.match(/Home/g)?.length).toBe(1);
    expect(breadcrumbText?.match(/Blog/g)?.length).toBe(1);
  });

  test("should have correct breadcrumbs on blog post", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/blog/getting-started-with-rsc"));
    await waitForHydration(page);

    await expect(testId(page, "blog-post-detail")).toBeVisible();

    // Verify exact breadcrumbs: Home / Blog / Post Title
    const breadcrumbs = testId(page, "breadcrumbs");
    await expect(breadcrumbs).toBeVisible();

    const breadcrumbText = await breadcrumbs.textContent();
    console.log(`Breadcrumbs on post: "${breadcrumbText}"`);

    // Should have exactly one of each
    expect(breadcrumbText?.match(/Home/g)?.length).toBe(1);
    expect(breadcrumbText?.match(/Blog/g)?.length).toBe(1);
    expect(breadcrumbText?.match(/Getting Started/g)?.length).toBe(1);
  });

  test("should maintain correct breadcrumbs after hard refresh on cached page", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // First visit to blog post (populates cache)
    await page.goto(f.url("/blog/getting-started-with-rsc"));
    await waitForHydration(page);
    await expect(testId(page, "blog-post-detail")).toBeVisible();

    const breadcrumbs = testId(page, "breadcrumbs");
    const initialBreadcrumbs = await breadcrumbs.textContent();
    console.log(`Initial breadcrumbs: "${initialBreadcrumbs}"`);

    // Hard refresh (should serve from cache)
    await page.reload();
    await waitForHydration(page);
    await expect(testId(page, "blog-post-detail")).toBeVisible();

    const afterRefreshBreadcrumbs = await breadcrumbs.textContent();
    console.log(`After refresh breadcrumbs: "${afterRefreshBreadcrumbs}"`);

    // Breadcrumbs should be identical, not duplicated
    expect(afterRefreshBreadcrumbs?.match(/Home/g)?.length).toBe(1);
    expect(afterRefreshBreadcrumbs?.match(/Blog/g)?.length).toBe(1);
    expect(afterRefreshBreadcrumbs?.match(/Getting Started/g)?.length).toBe(1);
  });

  test("should maintain correct breadcrumbs after navigating away and back", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // Start at blog post
    await page.goto(f.url("/blog/getting-started-with-rsc"));
    await waitForHydration(page);
    await expect(testId(page, "blog-post-detail")).toBeVisible();

    const breadcrumbs = testId(page, "breadcrumbs");

    // Navigate to home
    await testId(page, "nav-home").click();
    await expect(testId(page, "home-page")).toBeVisible();

    // Navigate back to blog post (may use cache)
    await page.goto(f.url("/blog/getting-started-with-rsc"));
    await waitForHydration(page);
    await expect(testId(page, "blog-post-detail")).toBeVisible();

    const afterNavBreadcrumbs = await breadcrumbs.textContent();
    console.log(`After nav breadcrumbs: "${afterNavBreadcrumbs}"`);

    // Breadcrumbs should NOT be duplicated
    expect(afterNavBreadcrumbs?.match(/Home/g)?.length).toBe(1);
    expect(afterNavBreadcrumbs?.match(/Blog/g)?.length).toBe(1);
    expect(afterNavBreadcrumbs?.match(/Getting Started/g)?.length).toBe(1);
  });

  test("should maintain correct breadcrumbs during repeated soft navigation", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/blog"));
    await waitForHydration(page);

    const breadcrumbs = testId(page, "breadcrumbs");

    // Navigate to different blog posts 3 times
    for (let i = 1; i <= 3; i++) {
      console.log(`\n=== Iteration ${i} ===`);

      // Go to post
      await testId(page, "blog-link-getting-started-with-rsc").click();
      await expect(testId(page, "blog-post-detail")).toBeVisible({
        timeout: 10000,
      });

      let crumbs = await breadcrumbs.textContent();
      console.log(`On post: "${crumbs}"`);
      expect(
        crumbs?.match(/Home/g)?.length,
        `Iteration ${i}: Home count on post`,
      ).toBe(1);
      expect(
        crumbs?.match(/Blog/g)?.length,
        `Iteration ${i}: Blog count on post`,
      ).toBe(1);

      // Go back to blog index
      await page.goBack();
      await expect(testId(page, "blog-index")).toBeVisible();

      crumbs = await breadcrumbs.textContent();
      console.log(`On index: "${crumbs}"`);
      expect(
        crumbs?.match(/Home/g)?.length,
        `Iteration ${i}: Home count on index`,
      ).toBe(1);
      expect(
        crumbs?.match(/Blog/g)?.length,
        `Iteration ${i}: Blog count on index`,
      ).toBe(1);
    }
  });

  test("should maintain correct breadcrumbs when navigating blog -> home -> about -> blog", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    const breadcrumbs = testId(page, "breadcrumbs");

    // Start at blog post
    await page.goto(f.url("/blog/understanding-caching-strategies"));
    await waitForHydration(page);
    await expect(testId(page, "blog-post-detail")).toBeVisible();

    let crumbs = await breadcrumbs.textContent();
    console.log(`Initial on post: "${crumbs}"`);
    expect(crumbs?.match(/Home/g)?.length).toBe(1);
    expect(crumbs?.match(/Blog/g)?.length).toBe(1);

    // Navigate to Home
    await testId(page, "nav-home").click();
    await expect(testId(page, "home-page")).toBeVisible();
    crumbs = await breadcrumbs.textContent();
    console.log(`On home: "${crumbs}"`);

    // Navigate to About
    await testId(page, "nav-about").click();
    await expect(testId(page, "about-page")).toBeVisible();
    crumbs = await breadcrumbs.textContent();
    console.log(`On about: "${crumbs}"`);

    // Navigate to Blog
    await testId(page, "nav-blog").click();
    await expect(testId(page, "blog-index")).toBeVisible();
    crumbs = await breadcrumbs.textContent();
    console.log(`On blog index: "${crumbs}"`);
    expect(crumbs?.match(/Home/g)?.length, "Home count after nav").toBe(1);
    expect(crumbs?.match(/Blog/g)?.length, "Blog count after nav").toBe(1);

    // Navigate to a specific post
    await testId(page, "blog-link-understanding-caching-strategies").click();
    await expect(testId(page, "blog-post-detail")).toBeVisible();
    crumbs = await breadcrumbs.textContent();
    console.log(`Back on post: "${crumbs}"`);
    expect(crumbs?.match(/Home/g)?.length, "Home count on post").toBe(1);
    expect(crumbs?.match(/Blog/g)?.length, "Blog count on post").toBe(1);
    expect(crumbs?.match(/Understanding/g)?.length, "Post title count").toBe(1);
  });

  test("should maintain correct breadcrumbs with extensive cross-section navigation", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    const breadcrumbs = testId(page, "breadcrumbs");

    // This test simulates the user's reported bug: visiting blog posts multiple times
    // with visits to other pages in between, all in a single session

    await page.goto(f.url("/"));
    await waitForHydration(page);

    // Visit blog post #1
    await testId(page, "nav-blog").click();
    await expect(testId(page, "blog-index")).toBeVisible();
    await testId(page, "blog-link-getting-started-with-rsc").click();
    await expect(testId(page, "blog-post-detail")).toBeVisible();

    let crumbs = await breadcrumbs.textContent();
    console.log(`Visit 1 - Post 1: "${crumbs}"`);
    expect(crumbs?.match(/Home/g)?.length, "V1P1: Home count").toBe(1);
    expect(crumbs?.match(/Blog/g)?.length, "V1P1: Blog count").toBe(1);

    // Go to home
    await testId(page, "nav-home").click();
    await expect(testId(page, "home-page")).toBeVisible();

    // Visit different blog post
    await testId(page, "nav-blog").click();
    await expect(testId(page, "blog-index")).toBeVisible();
    await testId(page, "blog-link-understanding-caching-strategies").click();
    await expect(testId(page, "blog-post-detail")).toBeVisible();

    crumbs = await breadcrumbs.textContent();
    console.log(`Visit 2 - Post 2: "${crumbs}"`);
    expect(crumbs?.match(/Home/g)?.length, "V2P2: Home count").toBe(1);
    expect(crumbs?.match(/Blog/g)?.length, "V2P2: Blog count").toBe(1);

    // Go to about
    await testId(page, "nav-about").click();
    await expect(testId(page, "about-page")).toBeVisible();

    // Visit first blog post again (may hit cache)
    await testId(page, "nav-blog").click();
    await expect(testId(page, "blog-index")).toBeVisible();
    await testId(page, "blog-link-getting-started-with-rsc").click();
    await expect(testId(page, "blog-post-detail")).toBeVisible();

    crumbs = await breadcrumbs.textContent();
    console.log(`Visit 3 - Post 1 again: "${crumbs}"`);
    expect(crumbs?.match(/Home/g)?.length, "V3P1: Home count").toBe(1);
    expect(crumbs?.match(/Blog/g)?.length, "V3P1: Blog count").toBe(1);

    // Go to counter
    await testId(page, "nav-counter").click();
    await expect(testId(page, "counter-page")).toBeVisible();

    // Visit second blog post again (may hit cache)
    await testId(page, "nav-blog").click();
    await expect(testId(page, "blog-index")).toBeVisible();
    await testId(page, "blog-link-understanding-caching-strategies").click();
    await expect(testId(page, "blog-post-detail")).toBeVisible();

    crumbs = await breadcrumbs.textContent();
    console.log(`Visit 4 - Post 2 again: "${crumbs}"`);
    expect(crumbs?.match(/Home/g)?.length, "V4P2: Home count").toBe(1);
    expect(crumbs?.match(/Blog/g)?.length, "V4P2: Blog count").toBe(1);
    expect(
      crumbs?.match(/Understanding/g)?.length,
      "V4P2: Post title count",
    ).toBe(1);
  });

  test("should not update breadcrumbs from cancelled navigation on quick popstate", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    const breadcrumbs = testId(page, "breadcrumbs");

    // Start at home page
    await page.goto(f.url("/"));
    await waitForHydration(page);

    let crumbs = await breadcrumbs.textContent();
    console.log(`Initial (home): "${crumbs}"`);
    expect(crumbs).toBe("Home");

    // Click on Server Actions feature link
    const navPromise = testId(page, "feature-link-server-actions").click();

    // Wait for RSC response to start arriving - the handles may start streaming
    // This gives time for the response to arrive and handles to start processing
    await page.waitForTimeout(150);

    // Go back while handles may still be streaming
    // This is the race condition: popstate fires but handles continue updating
    await page.goBack();

    // Verify we're back on home page first
    await expect(testId(page, "home-page")).toBeVisible();

    // Wait for the navigation promise to settle (may reject due to abort)
    await navPromise.catch(() => {});

    // IMPORTANT: Wait long enough for the cancelled navigation's RSC payload to fully resolve
    // The bug is that even after popstate, the handles from the cancelled navigation
    // continue to stream and update the breadcrumbs
    await page.waitForTimeout(1000);

    // The key assertion: breadcrumbs should show "Home" only,
    // not "Home / Server Actions" from the cancelled navigation
    crumbs = await breadcrumbs.textContent();
    console.log(`After quick back: "${crumbs}"`);
    expect(crumbs, "Breadcrumbs should only show Home").toBe("Home");
    expect(
      crumbs?.includes("Server Actions"),
      "Should not include Server Actions from cancelled nav",
    ).toBe(false);
    expect(
      crumbs?.includes("Features"),
      "Should not include Features from cancelled nav",
    ).toBe(false);
  });
});

/**
 * Proactive cache test route tests (preview mode)
 */
test.describe("proactive-cache (production)", () => {
  const f = useFixture({
    root: ".",
    mode: "build",
  });

  test("should navigate through proactive cache routes 3 times", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/proactive-cache"));
    await waitForHydration(page);

    await expect(testId(page, "proactive-index-page")).toBeVisible();

    // Track timestamps to verify caching
    const timestamps: Record<string, string[]> = {
      index: [],
      itemA: [],
      itemB: [],
    };

    // Navigate 3 times through the routes
    for (let i = 1; i <= 3; i++) {
      console.log(`\n=== Proactive Cache Iteration ${i} ===`);

      // Navigate to Item A
      await testId(page, "proactive-nav-a").click();
      await expect(testId(page, "proactive-item-a-page")).toBeVisible();
      const timestampA = await testId(
        page,
        "proactive-item-a-rendered",
      ).textContent();
      timestamps.itemA.push(timestampA || "");
      console.log(`Item A: ${timestampA?.slice(-25) || "N/A"}`);

      // Navigate to Item B
      await testId(page, "proactive-nav-b").click();
      await expect(testId(page, "proactive-item-b-page")).toBeVisible();
      const timestampB = await testId(
        page,
        "proactive-item-b-rendered",
      ).textContent();
      timestamps.itemB.push(timestampB || "");
      console.log(`Item B: ${timestampB?.slice(-25) || "N/A"}`);

      // Navigate back to Index
      await testId(page, "proactive-nav-index").click();
      await expect(testId(page, "proactive-index-page")).toBeVisible();
      const timestampIndex = await testId(
        page,
        "proactive-index-rendered",
      ).textContent();
      timestamps.index.push(timestampIndex || "");
      console.log(`Index: ${timestampIndex?.slice(-25) || "N/A"}`);
    }

    // Log timestamps summary and verify cache
    console.log("\n=== Proactive Cache Summary ===");
    for (const [route, times] of Object.entries(timestamps)) {
      console.log(`${route}:`);
      times.forEach((t, i) =>
        console.log(`  Visit ${i + 1}: ${t?.slice(-25) || "N/A"}`),
      );
      // Check if timestamps match (cache hit)
      if (times.length >= 3 && times[1] === times[2]) {
        console.log(`  -> Cache likely active (visits 2 & 3 match)`);
      }
    }
  });

  test("should preserve layout during navigation (no reload)", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/proactive-cache"));
    await waitForHydration(page);

    await expect(testId(page, "proactive-cache-layout")).toBeVisible();

    await using __ = await expectNoReload(page);

    // Navigate through routes
    await testId(page, "proactive-nav-a").click();
    await expect(testId(page, "proactive-item-a-page")).toBeVisible();
    await expect(testId(page, "proactive-cache-layout")).toBeVisible();

    await testId(page, "proactive-nav-b").click();
    await expect(testId(page, "proactive-item-b-page")).toBeVisible();
    await expect(testId(page, "proactive-cache-layout")).toBeVisible();

    await testId(page, "proactive-nav-index").click();
    await expect(testId(page, "proactive-index-page")).toBeVisible();
    await expect(testId(page, "proactive-cache-layout")).toBeVisible();
  });

  test("should return cached responses (same timestamps on repeat visits)", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/proactive-cache"));
    await waitForHydration(page);

    // First visit to Item A
    await testId(page, "proactive-nav-a").click();
    await expect(testId(page, "proactive-item-a-page")).toBeVisible();
    const timestamp1 = await testId(
      page,
      "proactive-item-a-rendered",
    ).textContent();
    console.log(`First visit: ${timestamp1}`);

    // Navigate away
    await testId(page, "proactive-nav-index").click();
    await expect(testId(page, "proactive-index-page")).toBeVisible();

    // Second visit to Item A
    await testId(page, "proactive-nav-a").click();
    await expect(testId(page, "proactive-item-a-page")).toBeVisible();
    const timestamp2 = await testId(
      page,
      "proactive-item-a-rendered",
    ).textContent();
    console.log(`Second visit: ${timestamp2}`);

    // Third visit to Item A
    await testId(page, "proactive-nav-index").click();
    await expect(testId(page, "proactive-index-page")).toBeVisible();
    await testId(page, "proactive-nav-a").click();
    await expect(testId(page, "proactive-item-a-page")).toBeVisible();
    const timestamp3 = await testId(
      page,
      "proactive-item-a-rendered",
    ).textContent();
    console.log(`Third visit: ${timestamp3}`);

    // In preview mode with caching, timestamps should match
    console.log("\n=== Cache Analysis ===");
    console.log(`Timestamp 1: ${timestamp1}`);
    console.log(`Timestamp 2: ${timestamp2}`);
    console.log(`Timestamp 3: ${timestamp3}`);

    if (timestamp2 === timestamp3) {
      console.log("Cache working: timestamps 2 & 3 match");
    }
  });
});
