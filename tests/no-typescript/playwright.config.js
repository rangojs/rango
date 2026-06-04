import { defineConfig, devices } from "@playwright/test";

const browserConfig = {
  ...devices["Desktop Chrome"],
  viewport: null,
  deviceScaleFactor: undefined,
};

export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  globalTimeout: 600000,
  timeout: process.env.CI ? 60000 : 30000,
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
      testMatch: "**/build-test-app.setup.js",
    },
    {
      name: "dev",
      grep: /^(?!.*\(production\))/,
      testIgnore: ["**/*.setup.js"],
      use: browserConfig,
      // No build dependency: each worker's dev server uses an isolated Vite
      // cache dir (set by the dev fixture via RANGO_NOTS_VITE_CACHE_DIR), so it
      // neither needs the build output nor can be clobbered by the build's
      // optimizer cache.
    },
    {
      name: "production",
      grep: /\(production\)/,
      testIgnore: ["**/*.setup.js"],
      use: browserConfig,
      // Production tests each spin up their own preview server; run serially to
      // avoid port conflicts.
      fullyParallel: false,
      dependencies: ["build"],
    },
  ],
  workers: process.env.CI ? 2 : 4,
  forbidOnly: !!process.env.CI,
  retries: 2,
  reporter: [
    ["list"],
    ...(process.env.CI ? [["github"], ["html", { open: "never" }]] : []),
  ],
});
