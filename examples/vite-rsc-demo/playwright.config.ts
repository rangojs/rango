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
      name: "build",
      testMatch: "**/build-test-app.setup.ts",
    },
    {
      name: "dev",
      grep: /^(?!.*\(production\))/,
      testIgnore: ["**/*.setup.ts"],
      use: browserConfig,
    },
    {
      name: "production",
      grep: /\(production\)/,
      testIgnore: ["**/*.setup.ts"],
      use: browserConfig,
      // Run production tests serially to avoid port conflicts
      // Each test file spins up its own preview server
      fullyParallel: false,
      dependencies: ["build"],
    },
  ],
  workers: process.env.CI ? 3 : 4,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: [
    ["list"],
    ...(process.env.CI ? [["github"], ["html", { open: "never" }]] : []),
  ] as import("@playwright/test").ReporterDescription[],
});
