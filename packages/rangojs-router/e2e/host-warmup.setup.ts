import { test as setup, expect } from "@playwright/test";

// Warm the host-router dev server (e2e/test-app/.host-fixture) before the
// host-routing "(dev)" tests. The first SSR request triggers Vite's dep optimizer
// (cold), and the dev client entry only imports cleanly once that pre-bundle is
// ready. Priming here makes the dev tests' client boot fast and reliable, and
// avoids the cold-import "Unhandled rejection" log noise when a page closes mid
// dynamic-import. Mirrors dev-warmup.setup.ts for the host server. baseURL is the
// host dev server (set on the host-dev-warmup project).
setup("warmup host dev server", async ({ page, baseURL }) => {
  setup.setTimeout(60_000);

  // Route to a sub-app via the host-override cookie (the single-origin dev workflow
  // the host-routing tests use), then trigger and wait out the dep optimization.
  await page
    .context()
    .addCookies([
      { name: "x-rango-host", value: "a.localhost", url: baseURL! },
    ]);
  await page.goto(baseURL!);

  await expect(async () => {
    await page.reload();
    await page.waitForFunction(
      () => document.documentElement.hasAttribute("data-hydrated"),
      { timeout: 10_000 },
    );
  }).toPass({ timeout: 45_000, intervals: [2_000, 3_000, 5_000] });
});
