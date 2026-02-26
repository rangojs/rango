import { test as setup, expect } from "@playwright/test";

// Warm up the shared dev server before tests start.
// The first SSR request triggers Vite's dep optimizer to discover deps
// (ERR_OUTDATED_OPTIMIZED_DEP). This takes a few seconds, after which a
// page reload picks up the new pre-bundle and hydration succeeds.
setup("warmup dev server", async ({ page, baseURL }) => {
  setup.setTimeout(60_000);

  // First request triggers dep optimization
  await page.goto(baseURL!);

  // Wait for Vite to finish re-bundling deps and React to hydrate.
  // The per-attempt timeout is generous (10s) because the first page load
  // after a cold start can take several seconds for optimizer discovery,
  // pre-bundling, and client-side hydration to complete.
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
      { timeout: 10_000 },
    );
  }).toPass({ timeout: 45_000, intervals: [2_000, 3_000, 5_000] });
});
