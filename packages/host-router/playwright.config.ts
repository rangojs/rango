/**
 * Playwright E2E Test Configuration for Host Router
 *
 * Runs E2E tests against a test server to validate:
 * - Host pattern matching (apex, subdomains, paths)
 * - Cookie-based host override
 * - Middleware execution
 * - Fallback handler
 */

import { defineConfig, devices } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0, // Never retry - fail fast
  workers: 1, // Use single worker to avoid race conditions
  reporter: 'list', // Simple list output
  timeout: 30000, // 30 second timeout per test
  globalTimeout: 60000, // 60 second total timeout

  use: {
    baseURL: 'http://localhost:3100',
    trace: 'off',
    screenshot: 'off',
    actionTimeout: 10000,
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  // Auto-start test server
  webServer: {
    command: 'npx tsx tests/e2e/test-server.js',
    cwd: __dirname,
    url: 'http://localhost:3100',
    reuseExistingServer: !process.env.CI,
    timeout: 30 * 1000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
