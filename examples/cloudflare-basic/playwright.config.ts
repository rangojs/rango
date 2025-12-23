import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  // Run tests serially since cloudflare dev server has port conflicts when running in parallel
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // Use single worker to avoid multiple dev server instances
  workers: 1,
  reporter: "html",
  // Global timeout to prevent hanging
  globalTimeout: process.env.CI ? 15 * 60 * 1000 : undefined, // 15 min on CI
  // Extended timeout for CI where workerd startup can be slow
  timeout: process.env.CI ? 150000 : 30000, // 2.5 min per test on CI
  use: {
    trace: "on-first-retry",
    // Extended action timeout for CI
    actionTimeout: process.env.CI ? 30000 : 15000,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
