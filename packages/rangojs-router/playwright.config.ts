import { defineConfig, devices } from "@playwright/test";

const browserConfig = {
  ...devices["Desktop Chrome"],
  viewport: null,
  deviceScaleFactor: undefined,
};

const DEV_SERVER_PORT = 5188;

const isUIMode = process.argv.includes("--ui");

export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  globalTimeout: 600000, // 10 minutes max
  timeout: process.env.CI ? 60000 : 30000, // 60s on CI, 30s locally
  webServer: {
    command: `rm -rf node_modules/.vite && pnpm dev --port ${DEV_SERVER_PORT}`,
    cwd: "./e2e/test-app",
    port: DEV_SERVER_PORT,
    reuseExistingServer: !process.env.CI,
  },
  use: {
    screenshot: "only-on-failure",
    trace: "on-all-retries",
  },
  expect: {
    toPass: { timeout: 10000 },
  },
  // In UI mode, flatten projects to avoid the dependency chain that breaks
  // Playwright's --ui filtering (--grep, --project, file args).
  // See: https://github.com/microsoft/playwright/issues/21952
  projects: isUIMode
    ? [
        {
          name: "dev",
          grep: /^(?!.*\(production\))/,
          testIgnore: [
            "**/loader-hmr.test.ts",
            "**/route-types-hmr.test.ts",
            "**/*.setup.ts",
          ],
          use: {
            ...browserConfig,
            baseURL: `http://localhost:${DEV_SERVER_PORT}`,
          },
        },
        {
          name: "production",
          grep: /\(production\)/,
          use: browserConfig,
          fullyParallel: false,
        },
        {
          name: "hmr",
          testMatch: ["**/loader-hmr.test.ts", "**/route-types-hmr.test.ts"],
          use: browserConfig,
          fullyParallel: false,
        },
      ]
    : [
        {
          name: "build",
          testMatch: "**/build-test-app.setup.ts",
        },
        {
          name: "dev-warmup",
          testMatch: "**/dev-warmup.setup.ts",
          use: {
            ...browserConfig,
            baseURL: `http://localhost:${DEV_SERVER_PORT}`,
          },
          // Must run after build: both write to node_modules/.vite/deps_ssr and the
          // build overwrites the dev server's optimizer cache, causing ERR_OUTDATED_OPTIMIZED_DEP.
          dependencies: ["build"],
        },
        {
          name: "dev",
          // Exclude production tests (by test name) and HMR test files (by file name)
          grep: /^(?!.*\(production\))/,
          testIgnore: [
            "**/loader-hmr.test.ts",
            "**/route-types-hmr.test.ts",
            "**/*.setup.ts",
          ],
          use: {
            ...browserConfig,
            baseURL: `http://localhost:${DEV_SERVER_PORT}`,
          },
          dependencies: ["dev-warmup"],
        },
        {
          name: "production",
          grep: /\(production\)/,
          use: browserConfig,
          // Run production tests serially to avoid port conflicts
          // Each test file spins up its own preview server
          fullyParallel: false,
          dependencies: ["build"],
        },
        {
          name: "hmr",
          // Only run HMR test files
          testMatch: ["**/loader-hmr.test.ts", "**/route-types-hmr.test.ts"],
          use: browserConfig,
          // HMR tests modify files, run serially to avoid conflicts
          fullyParallel: false,
          // Run after dev and production tests complete (only locally, not in CI where projects run in separate jobs)
          dependencies: process.env.CI ? [] : ["dev", "production"],
        },
      ],
  workers: process.env.CI ? 3 : 6,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: [
    ["list"],
    ...(process.env.CI ? [["github"], ["html", { open: "never" }]] : []),
  ] as import("@playwright/test").ReporterDescription[],
});
