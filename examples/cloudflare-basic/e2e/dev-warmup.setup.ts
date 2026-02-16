import { test as setup, expect } from "@playwright/test";

// Warm up the shared dev server before tests start.
// The first SSR request triggers Vite's dep optimizer to discover SSR deps
// (ERR_OUTDATED_OPTIMIZED_DEP). This takes a few seconds, after which a
// page reload picks up the new pre-bundle and hydration succeeds.
setup("warmup dev server", async ({ page, baseURL }) => {
  setup.setTimeout(60_000);

  // First request triggers SSR dep optimization
  await page.goto(baseURL!);

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
