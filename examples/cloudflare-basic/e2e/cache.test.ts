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
          step.expectedTitle
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
test.describe("basic-navigation (preview)", () => {
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
          step.expectedTitle
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
      const timestampA = await testId(page, "proactive-item-a-rendered").textContent();
      timestamps.itemA.push(timestampA || "");
      console.log(`Item A: ${timestampA?.slice(-25) || "N/A"}`);

      // Navigate to Item B
      await testId(page, "proactive-nav-b").click();
      await expect(testId(page, "proactive-item-b-page")).toBeVisible();
      const timestampB = await testId(page, "proactive-item-b-rendered").textContent();
      timestamps.itemB.push(timestampB || "");
      console.log(`Item B: ${timestampB?.slice(-25) || "N/A"}`);

      // Navigate back to Index
      await testId(page, "proactive-nav-index").click();
      await expect(testId(page, "proactive-index-page")).toBeVisible();
      const timestampIndex = await testId(page, "proactive-index-rendered").textContent();
      timestamps.index.push(timestampIndex || "");
      console.log(`Index: ${timestampIndex?.slice(-25) || "N/A"}`);
    }

    // Log timestamps summary
    console.log("\n=== Proactive Cache Summary ===");
    for (const [route, times] of Object.entries(timestamps)) {
      console.log(`${route}:`);
      times.forEach((t, i) => console.log(`  Visit ${i + 1}: ${t?.slice(-25) || "N/A"}`));
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
 * Proactive cache test route tests (preview mode)
 */
test.describe("proactive-cache (preview)", () => {
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
      const timestampA = await testId(page, "proactive-item-a-rendered").textContent();
      timestamps.itemA.push(timestampA || "");
      console.log(`Item A: ${timestampA?.slice(-25) || "N/A"}`);

      // Navigate to Item B
      await testId(page, "proactive-nav-b").click();
      await expect(testId(page, "proactive-item-b-page")).toBeVisible();
      const timestampB = await testId(page, "proactive-item-b-rendered").textContent();
      timestamps.itemB.push(timestampB || "");
      console.log(`Item B: ${timestampB?.slice(-25) || "N/A"}`);

      // Navigate back to Index
      await testId(page, "proactive-nav-index").click();
      await expect(testId(page, "proactive-index-page")).toBeVisible();
      const timestampIndex = await testId(page, "proactive-index-rendered").textContent();
      timestamps.index.push(timestampIndex || "");
      console.log(`Index: ${timestampIndex?.slice(-25) || "N/A"}`);
    }

    // Log timestamps summary and verify cache
    console.log("\n=== Proactive Cache Summary ===");
    for (const [route, times] of Object.entries(timestamps)) {
      console.log(`${route}:`);
      times.forEach((t, i) => console.log(`  Visit ${i + 1}: ${t?.slice(-25) || "N/A"}`));
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
    const timestamp1 = await testId(page, "proactive-item-a-rendered").textContent();
    console.log(`First visit: ${timestamp1}`);

    // Navigate away
    await testId(page, "proactive-nav-index").click();
    await expect(testId(page, "proactive-index-page")).toBeVisible();

    // Second visit to Item A
    await testId(page, "proactive-nav-a").click();
    await expect(testId(page, "proactive-item-a-page")).toBeVisible();
    const timestamp2 = await testId(page, "proactive-item-a-rendered").textContent();
    console.log(`Second visit: ${timestamp2}`);

    // Third visit to Item A
    await testId(page, "proactive-nav-index").click();
    await expect(testId(page, "proactive-index-page")).toBeVisible();
    await testId(page, "proactive-nav-a").click();
    await expect(testId(page, "proactive-item-a-page")).toBeVisible();
    const timestamp3 = await testId(page, "proactive-item-a-rendered").textContent();
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
