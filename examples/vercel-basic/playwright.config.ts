import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  // Serial: dev and production specs each spin up their own server (build +
  // function preview), so avoid port/build contention.
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: "html",
  globalTimeout: process.env.CI ? 10 * 60 * 1000 : undefined,
  timeout: process.env.CI ? 60000 : 30000,
  use: {
    trace: "on-first-retry",
    actionTimeout: process.env.CI ? 30000 : 15000,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
