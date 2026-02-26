import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 3 : 4,
  reporter: "html",
  // Global timeout to prevent hanging
  globalTimeout: process.env.CI ? 10 * 60 * 1000 : undefined, // 10 min on CI
  // Extended timeout for CI where workerd startup can be slow
  timeout: process.env.CI ? 60000 : 30000,
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
