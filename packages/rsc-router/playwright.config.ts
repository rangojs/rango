/**
 * Playwright E2E Test Configuration
 *
 * Runs E2E tests against the example app to validate:
 * - Real browser RSC streaming
 * - SPA navigation
 * - Partial rendering
 * - Segment management
 */

import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',

  use: {
    baseURL: 'http://localhost:3002',
    trace: 'on-first-retry',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },

    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'] },
    },

    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'] },
    },
  ],

  // Run dev server before E2E tests
  webServer: {
    command: 'cd e2e/fixtures/test-app && npm run dev',
    url: 'http://localhost:3002',
    reuseExistingServer: !process.env.CI,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
