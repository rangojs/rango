/**
 * Playwright E2E Test Configuration
 *
 * Runs E2E tests against the web app to validate:
 * - Real browser RSC streaming
 * - SPA navigation with _has parameter
 * - Partial rendering and differential updates
 * - Segment-based reconciliation
 * - Layout preservation
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
  reporter: 'list', // Simple list output, no HTML reports
  timeout: 30000, // 30 second timeout per test
  globalTimeout: 60000, // 60 second total timeout

  use: {
    baseURL: 'http://localhost:5173',
    trace: 'off', // Don't generate traces
    screenshot: 'off', // Don't take screenshots
    actionTimeout: 10000, // 10 second timeout for actions
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  // Auto-start dev server and show logs
  webServer: {
    command: 'pnpm dev',
    cwd: path.resolve(__dirname, '../../apps/web'),
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 30 * 1000,
    stdout: 'pipe', // Show server logs in test output
    stderr: 'pipe',
  },
});
