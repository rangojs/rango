import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, testId } from "./helper";
import fs from "node:fs";
import path from "node:path";

/**
 * HMR tests for basename changes and loader updates.
 *
 * LOCAL ONLY — skipped on CI because file-watcher flakiness on
 * virtualized FS makes HMR timing unreliable, and these tests modify
 * the router config which cascades through route rediscovery.
 */
test.skip(!!process.env.CI, "local-only HMR test — skipped on CI");

// ---------------------------------------------------------------------------
// Loader HMR — regression: loader function stays stale after file change
// ---------------------------------------------------------------------------
test.describe.serial("loader-hmr", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });

  test.setTimeout(60_000);

  const loadersPath = path.resolve("./e2e/test-app/src/loaders.tsx");
  let loadersOriginal: string;

  test.beforeAll(async () => {
    loadersOriginal = fs.readFileSync(loadersPath, "utf-8");
  });

  test.afterAll(async () => {
    fs.writeFileSync(loadersPath, loadersOriginal);
    await new Promise((r) => setTimeout(r, 3000));
  });

  test("editing loader data updates via HMR", async ({ page }) => {
    // Navigate to index which uses ProductsLoader
    await page.goto(f.url("/"));
    await waitForHydration(page);

    // Verify initial product name
    await expect(testId(page, "product-card-product-a")).toContainText(
      "Product A",
    );

    // Modify the product name in the loader file
    const modified = loadersOriginal.replace(
      'name: "Product A"',
      'name: "HMR Product A"',
    );
    expect(modified).not.toBe(loadersOriginal);
    fs.writeFileSync(loadersPath, modified);

    // The loader should update via HMR — the product name should change
    await expect(testId(page, "product-card-product-a")).toContainText(
      "HMR Product A",
      { timeout: 15000 },
    );
  });
});

// ---------------------------------------------------------------------------
// Basename HMR — regression: route matching / reverse broken after adding basename
// ---------------------------------------------------------------------------
test.describe.serial("basename-hmr", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });

  test.setTimeout(60_000);

  const routerPath = path.resolve("./e2e/test-app/src/router.tsx");
  let routerOriginal: string;

  test.beforeAll(async () => {
    routerOriginal = fs.readFileSync(routerPath, "utf-8");
  });

  test.afterAll(async () => {
    fs.writeFileSync(routerPath, routerOriginal);
    await new Promise((r) => setTimeout(r, 3000));
  });

  test("adding basename updates route matching and reverse map via HMR", async ({
    page,
  }) => {
    // ── Step 1: Verify routes work without basename ──

    await page.goto(f.url("/blog"));
    await waitForHydration(page);
    await expect(testId(page, "blog-index-page")).toBeVisible();

    // Verify reverse map has correct patterns (no basename prefix)
    // path.json wraps response in { data: ... }
    const reverseResponse = await page.request.get(
      f.url("/__debug/reverse-test?name=blog.index&name=blog.post"),
    );
    expect(reverseResponse.status()).toBe(200);
    const reverseBody = await reverseResponse.json();
    expect(reverseBody.data["blog.index"]).toBe("/blog");
    expect(reverseBody.data["blog.post"]).toBe("/blog/:postId");

    // ── Step 2: Add basename to router config ──

    const modified = routerOriginal.replace(
      "export const router = createRouter<AppEnv>({",
      'export const router = createRouter<AppEnv>({\n  basename: "/app",',
    );
    expect(modified).not.toBe(routerOriginal);
    fs.writeFileSync(routerPath, modified);

    // Wait for HMR to process the router config change + route rediscovery
    await page.waitForTimeout(5000);

    // ── Step 3: Verify routes work under new basename ──

    // Poll for the route to become available at the new basename
    await expect
      .poll(
        async () => {
          try {
            const res = await page.request.get(f.url("/app/blog"), {
              headers: { accept: "text/html" },
            });
            return res.status();
          } catch {
            return 0;
          }
        },
        {
          message: "Expected /app/blog to return 200 after basename HMR update",
          timeout: 15000,
          intervals: [1000],
        },
      )
      .toBe(200);

    // Navigate in the browser and verify rendering
    await page.goto(f.url("/app/blog"));
    await waitForHydration(page);
    await expect(testId(page, "blog-index-page")).toBeVisible();

    // ── Step 4: Verify reverse map is updated with basename prefix ──

    const reverseAfter = await page.request.get(
      f.url("/app/__debug/reverse-test?name=blog.index&name=blog.post"),
    );
    expect(reverseAfter.status()).toBe(200);
    const reverseAfterBody = await reverseAfter.json();
    expect(reverseAfterBody.data["blog.index"]).toBe("/app/blog");
    expect(reverseAfterBody.data["blog.post"]).toBe("/app/blog/:postId");
  });
});
