import { defineConfig, devices } from "@playwright/test";

const browserConfig = {
  ...devices["Desktop Chrome"],
  viewport: null,
  deviceScaleFactor: undefined,
};

export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  globalTimeout: 600000, // 10 minutes max
  timeout: process.env.CI ? 60000 : 30000, // 60s on CI, 30s locally
  use: {
    screenshot: "only-on-failure",
    trace: "on-all-retries",
  },
  expect: {
    toPass: { timeout: 10000 },
  },
  projects: [
    {
      name: "dev",
      // Exclude production tests (by test name) and HMR test files (by file name)
      grep: /^(?!.*\(production\))/,
      testIgnore: ["**/hmr.test.ts", "**/loader-hmr.test.ts"],
      use: browserConfig,
    },
    {
      name: "production",
      grep: /\(production\)/,
      use: browserConfig,
      // Run production tests serially to avoid port conflicts
      // Each test file spins up its own preview server
      fullyParallel: false,
      // Use single worker to prevent parallel server startups
      metadata: { workers: 1 },
    },
    {
      name: "hmr",
      // Only run HMR test files (hmr.test.ts, loader-hmr.test.ts)
      testMatch: ["**/hmr.test.ts", "**/loader-hmr.test.ts"],
      use: browserConfig,
      // HMR tests modify files, run serially to avoid conflicts
      fullyParallel: false,
      // Run after dev and production tests complete
      dependencies: ["dev", "production"],
    },
  ],
  workers: process.env.CI ? 2 : 4,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: [
    ["list"],
    ...(process.env.CI ? [["github"], ["html", { open: "never" }]] : []),
  ] as import("@playwright/test").ReporterDescription[],
});
