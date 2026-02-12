import { test as setup, expect } from "@playwright/test";

// Warm up the shared dev server before tests start.
// The first SSR request triggers Vite's dep optimizer to discover SSR deps
// (ERR_OUTDATED_OPTIMIZED_DEP). This takes a few seconds, after which a
// page reload picks up the new pre-bundle and hydration succeeds.
// We also warm up deep routes (shop product pages) to ensure all SSR
// dependencies are discovered before parallel tests hit these routes.
setup("warmup dev server", async ({ page, baseURL }) => {
  setup.setTimeout(60_000);

  // First request triggers SSR dep optimization for root route deps
  await page.goto(baseURL!);

  // Warm up a deep shop route to discover additional SSR deps
  // (shop pages import different dependencies than the root)
  await page.goto(new URL("/shop/product/wireless-headphones", baseURL!).href);

  // Wait for Vite to finish re-bundling SSR deps
  await expect(async () => {
    await page.reload();
    await page.waitForFunction(
      (selector) => {
        const el = document.querySelector(selector);
        return (
          el && Object.keys(el).some((key) => key.startsWith("__reactFiber"))
        );
      },
      "body",
      { timeout: 5_000 },
    );
  }).toPass({ timeout: 30_000, intervals: [2_000, 3_000, 5_000] });
});
