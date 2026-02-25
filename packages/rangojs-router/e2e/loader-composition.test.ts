import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError } from "./helper";

/**
 * Tests for ctx.use(loader) composition - loaders using other loaders
 * Also tests memoization - base loaders should only run once per request
 */
test.describe("loader-composition", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });

  test("non-fetchable loader using non-fetchable dependency works", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/loader-composition"));
    await waitForHydration(page);

    // Verify composition worked
    const section = page.locator('[data-testid="nf-uses-nf"]');
    await expect(section).toBeVisible();

    // Check data attributes
    await expect(section).toHaveAttribute("data-composer", "non-fetchable");
    await expect(section).toHaveAttribute("data-dependency", "non-fetchable");

    // Verify computed values
    await expect(page.locator('[data-testid="nf-uses-nf-base"]')).toContainText(
      "Base value: 100",
    );
    await expect(
      page.locator('[data-testid="nf-uses-nf-computed"]'),
    ).toContainText("Computed: 200"); // 100 * 2
  });

  test("non-fetchable loader using fetchable dependency works", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/loader-composition"));
    await waitForHydration(page);

    // Verify composition worked
    const section = page.locator('[data-testid="nf-uses-f"]');
    await expect(section).toBeVisible();

    // Check data attributes
    await expect(section).toHaveAttribute("data-composer", "non-fetchable");
    await expect(section).toHaveAttribute("data-dependency", "fetchable");

    // Verify computed values
    await expect(page.locator('[data-testid="nf-uses-f-base"]')).toContainText(
      "Base value: 200",
    );
    await expect(
      page.locator('[data-testid="nf-uses-f-computed"]'),
    ).toContainText("Computed: 400"); // 200 * 2
  });

  test("fetchable loader using fetchable dependency works", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/loader-composition"));
    await waitForHydration(page);

    // Verify composition worked
    const section = page.locator('[data-testid="f-uses-f"]');
    await expect(section).toBeVisible();

    // Check data attributes
    await expect(section).toHaveAttribute("data-composer", "fetchable");
    await expect(section).toHaveAttribute("data-dependency", "fetchable");

    // Verify computed values
    await expect(page.locator('[data-testid="f-uses-f-base"]')).toContainText(
      "Base value: 200",
    );
    await expect(
      page.locator('[data-testid="f-uses-f-computed"]'),
    ).toContainText("Computed: 600"); // 200 * 3
  });

  test("fetchable loader using non-fetchable dependency works", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/loader-composition"));
    await waitForHydration(page);

    // Verify composition worked
    const section = page.locator('[data-testid="f-uses-nf"]');
    await expect(section).toBeVisible();

    // Check data attributes
    await expect(section).toHaveAttribute("data-composer", "fetchable");
    await expect(section).toHaveAttribute("data-dependency", "non-fetchable");

    // Verify computed values
    await expect(page.locator('[data-testid="f-uses-nf-base"]')).toContainText(
      "Base value: 100",
    );
    await expect(
      page.locator('[data-testid="f-uses-nf-computed"]'),
    ).toContainText("Computed: 300"); // 100 * 3
  });

  test("base loaders are memoized - only invoked once per request", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/loader-composition"));
    await waitForHydration(page);

    // Both nf-uses-nf and f-uses-nf use BaseNonFetchableLoader
    // Both should show invocation count of 1 if memoization works
    await expect(
      page.locator('[data-testid="nf-uses-nf-invocations"]'),
    ).toContainText("Invocations: 1");
    await expect(
      page.locator('[data-testid="f-uses-nf-invocations"]'),
    ).toContainText("Invocations: 1");

    // Both nf-uses-f and f-uses-f use BaseFetchableLoader
    // Both should show invocation count of 1 if memoization works
    await expect(
      page.locator('[data-testid="nf-uses-f-invocations"]'),
    ).toContainText("Invocations: 1");
    await expect(
      page.locator('[data-testid="f-uses-f-invocations"]'),
    ).toContainText("Invocations: 1");
  });

  test("all composition patterns work together on SSR", async ({ page }) => {
    // No expectNoPageError here - blocking scripts causes expected import errors

    // Disable JavaScript to test SSR
    await page.context().route("**/*", (route) => {
      if (route.request().resourceType() === "script") {
        return route.abort();
      }
      return route.continue();
    });

    await page.goto(f.url("/loader-composition"));

    // All four sections should be rendered on server
    await expect(page.locator('[data-testid="nf-uses-nf"]')).toBeVisible();
    await expect(page.locator('[data-testid="nf-uses-f"]')).toBeVisible();
    await expect(page.locator('[data-testid="f-uses-f"]')).toBeVisible();
    await expect(page.locator('[data-testid="f-uses-nf"]')).toBeVisible();

    // Verify computed values are correct
    await expect(
      page.locator('[data-testid="nf-uses-nf-computed"]'),
    ).toContainText("Computed: 200");
    await expect(
      page.locator('[data-testid="nf-uses-f-computed"]'),
    ).toContainText("Computed: 400");
    await expect(
      page.locator('[data-testid="f-uses-f-computed"]'),
    ).toContainText("Computed: 600");
    await expect(
      page.locator('[data-testid="f-uses-nf-computed"]'),
    ).toContainText("Computed: 300");
  });
});

/**
 * Production build tests for loader composition
 * Ensures ctx.use(loader) works correctly after tree-shaking and bundling
 */
test.describe("loader-composition (production)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "build",
  });

  test.setTimeout(120000); // Build takes time

  test("all composition patterns work in production build", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/loader-composition"));
    await waitForHydration(page);

    // Verify all four sections render correctly
    await expect(page.locator('[data-testid="nf-uses-nf"]')).toBeVisible();
    await expect(page.locator('[data-testid="nf-uses-f"]')).toBeVisible();
    await expect(page.locator('[data-testid="f-uses-f"]')).toBeVisible();
    await expect(page.locator('[data-testid="f-uses-nf"]')).toBeVisible();

    // Verify computed values - confirms loader composition worked
    await expect(
      page.locator('[data-testid="nf-uses-nf-computed"]'),
    ).toContainText("Computed: 200");
    await expect(
      page.locator('[data-testid="nf-uses-f-computed"]'),
    ).toContainText("Computed: 400");
    await expect(
      page.locator('[data-testid="f-uses-f-computed"]'),
    ).toContainText("Computed: 600");
    await expect(
      page.locator('[data-testid="f-uses-nf-computed"]'),
    ).toContainText("Computed: 300");
  });

  test("memoization works in production build", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/loader-composition"));
    await waitForHydration(page);

    // All base loaders should only be invoked once (memoization)
    await expect(
      page.locator('[data-testid="nf-uses-nf-invocations"]'),
    ).toContainText("Invocations: 1");
    await expect(
      page.locator('[data-testid="f-uses-nf-invocations"]'),
    ).toContainText("Invocations: 1");
    await expect(
      page.locator('[data-testid="nf-uses-f-invocations"]'),
    ).toContainText("Invocations: 1");
    await expect(
      page.locator('[data-testid="f-uses-f-invocations"]'),
    ).toContainText("Invocations: 1");
  });
});
