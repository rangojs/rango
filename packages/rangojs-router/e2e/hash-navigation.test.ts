import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError } from "./helper";

/**
 * Hash-only navigation must bypass the SPA router and use native
 * browser anchor behavior. Clicking a hash link should NOT trigger
 * an RSC partial fetch.
 */
test.describe("hash-navigation", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });

  test("Link with hash-only href does not trigger RSC fetch", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/hash-navigation"));
    await waitForHydration(page);

    await expect(page.locator('[data-testid="hash-nav-page"]')).toBeVisible();

    // Track RSC partial requests
    const rscRequests: string[] = [];
    page.on("request", (req) => {
      if (req.url().includes("_rsc_partial")) {
        rscRequests.push(req.url());
      }
    });

    // Click the Link component hash link
    await page.locator('[data-testid="link-hash-a"]').click();

    // URL should have the hash fragment
    await expect(page).toHaveURL(/\/hash-navigation#section-a$/);

    // Page content should still be visible (no navigation occurred)
    await expect(page.locator('[data-testid="hash-nav-page"]')).toBeVisible();

    // No RSC partial request should have been made
    expect(rscRequests).toHaveLength(0);
  });

  test("plain anchor with hash does not trigger RSC fetch", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/hash-navigation"));
    await waitForHydration(page);

    const rscRequests: string[] = [];
    page.on("request", (req) => {
      if (req.url().includes("_rsc_partial")) {
        rscRequests.push(req.url());
      }
    });

    // Click the plain anchor hash link
    await page.locator('[data-testid="anchor-hash-a"]').click();

    await expect(page).toHaveURL(/\/hash-navigation#section-a$/);

    await expect(page.locator('[data-testid="hash-nav-page"]')).toBeVisible();

    expect(rscRequests).toHaveLength(0);
  });

  test("Link to different path still triggers SPA navigation", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/hash-navigation"));
    await waitForHydration(page);

    // Click a link to a different path
    await page.locator('[data-testid="link-different-path"]').click();

    // Should navigate away to /blog
    await expect(page).toHaveURL(/\/blog$/);
  });
});

test.describe("hash-navigation (production)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "build",
  });

  test("Link with hash-only href does not trigger RSC fetch", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/hash-navigation"));
    await waitForHydration(page);

    await expect(page.locator('[data-testid="hash-nav-page"]')).toBeVisible();

    const rscRequests: string[] = [];
    page.on("request", (req) => {
      if (req.url().includes("_rsc_partial")) {
        rscRequests.push(req.url());
      }
    });

    await page.locator('[data-testid="link-hash-a"]').click();

    await expect(page).toHaveURL(/\/hash-navigation#section-a$/);

    await expect(page.locator('[data-testid="hash-nav-page"]')).toBeVisible();

    expect(rscRequests).toHaveLength(0);
  });

  test("plain anchor with hash does not trigger RSC fetch", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/hash-navigation"));
    await waitForHydration(page);

    const rscRequests: string[] = [];
    page.on("request", (req) => {
      if (req.url().includes("_rsc_partial")) {
        rscRequests.push(req.url());
      }
    });

    await page.locator('[data-testid="anchor-hash-a"]').click();

    await expect(page).toHaveURL(/\/hash-navigation#section-a$/);

    await expect(page.locator('[data-testid="hash-nav-page"]')).toBeVisible();

    expect(rscRequests).toHaveLength(0);
  });

  test("Link to different path still triggers SPA navigation", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/hash-navigation"));
    await waitForHydration(page);

    await page.locator('[data-testid="link-different-path"]').click();

    await expect(page).toHaveURL(/\/blog$/);
  });
});
