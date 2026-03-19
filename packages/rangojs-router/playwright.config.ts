import { defineConfig, devices } from "@playwright/test";

const browserConfig = {
  ...devices["Desktop Chrome"],
  viewport: null,
  deviceScaleFactor: undefined,
};

const webkitConfig = {
  ...devices["Desktop Safari"],
};

const DEV_SERVER_PORT = 5188;
const PREVIEW_SERVER_PORT = 5189;

const isUIMode = process.argv.includes("--ui");

export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  globalTimeout: 600000, // 10 minutes max
  timeout: process.env.CI ? 60000 : 30000, // 60s on CI, 30s locally
  webServer: [
    {
      // Build first (for production tests), then clean optimizer cache and start
      // dev server. Building before the dev server prevents `vite build` from
      // overwriting the running server's optimizer cache (node_modules/.vite/deps).
      command: `pnpm build && rm -rf node_modules/.vite-e2e-test-app && pnpm dev --port ${DEV_SERVER_PORT}`,
      cwd: "./e2e/test-app",
      port: DEV_SERVER_PORT,
      reuseExistingServer: !process.env.CI,
    },
    {
      // Shared preview server for all production tests using test-app.
      // Started after the build (included in the dev server command above).
      command: `pnpm preview --port ${PREVIEW_SERVER_PORT}`,
      cwd: "./e2e/test-app",
      port: PREVIEW_SERVER_PORT,
      reuseExistingServer: !process.env.CI,
    },
  ],
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
          name: "smoke",
          testMatch: "**/smoke.test.ts",
          use: browserConfig,
        },
        {
          name: "dev",
          // Exclude any production-tagged describe blocks, including
          // variants like "(production build)".
          grep: /^(?!.*\(production)/,
          testIgnore: [
            "**/smoke.test.ts",
            "**/loader-hmr.test.ts",
            "**/route-types-hmr.test.ts",
            "**/client-component-hmr.test.ts",
            "**/intercept-hmr*.test.ts",
            "**/refresh-cmd.test.ts",
            "**/*.setup.ts",
          ],
          use: {
            ...browserConfig,
            baseURL: `http://localhost:${DEV_SERVER_PORT}`,
          },
        },
        {
          name: "production",
          grep: /\(production/,
          testIgnore: ["**/smoke.test.ts"],
          use: {
            ...browserConfig,
            baseURL: `http://localhost:${PREVIEW_SERVER_PORT}`,
          },
          fullyParallel: false,
        },
        {
          name: "hmr-client",
          testMatch: "**/client-component-hmr.test.ts",
          use: browserConfig,
          fullyParallel: false,
        },
        {
          name: "hmr-loader",
          testMatch: ["**/loader-hmr.test.ts", "**/refresh-cmd.test.ts"],
          use: browserConfig,
          fullyParallel: false,
        },
        {
          name: "hmr-routes",
          testMatch: "**/route-types-hmr.test.ts",
          use: browserConfig,
          fullyParallel: false,
        },
        {
          name: "hmr-intercept",
          testMatch: "**/intercept-hmr*.test.ts",
          use: browserConfig,
          fullyParallel: false,
        },
        {
          name: "webkit-smoke",
          testMatch: "**/smoke.test.ts",
          use: webkitConfig,
        },
      ]
    : [
        {
          name: "smoke",
          testMatch: "**/smoke.test.ts",
          use: browserConfig,
        },
        {
          name: "build",
          testMatch: "**/build-test-app.setup.ts",
          dependencies: ["smoke"],
        },
        {
          name: "dev-warmup",
          testMatch: "**/dev-warmup.setup.ts",
          use: {
            ...browserConfig,
            baseURL: `http://localhost:${DEV_SERVER_PORT}`,
          },
          dependencies: ["build"],
        },
        {
          name: "dev",
          // Exclude production tests (by test name) and HMR test files (by file name)
          grep: /^(?!.*\(production)/,
          testIgnore: [
            "**/smoke.test.ts",
            "**/loader-hmr.test.ts",
            "**/route-types-hmr.test.ts",
            "**/client-component-hmr.test.ts",
            "**/intercept-hmr*.test.ts",
            "**/refresh-cmd.test.ts",
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
          grep: /\(production/,
          testIgnore: ["**/smoke.test.ts"],
          use: {
            ...browserConfig,
            baseURL: `http://localhost:${PREVIEW_SERVER_PORT}`,
          },
          // Shared preview server on the built test-app has shown intermittent
          // connection-refused failures under long high-parallel runs. Keep the
          // production project serial for stability.
          fullyParallel: false,
          dependencies: ["build"],
        },
        {
          name: "hmr-client",
          testMatch: "**/client-component-hmr.test.ts",
          use: browserConfig,
          fullyParallel: false,
          // Run after build completes. On CI there are no dependencies so
          // HMR tests can start immediately. Locally we wait for the build
          // but NOT for dev/production — flaky dev tests must not block HMR.
          dependencies: process.env.CI ? [] : ["build"],
        },
        {
          name: "hmr-loader",
          // Loader HMR and refresh tests don't modify route definitions,
          // so they can run independently of route-modifying HMR tests.
          testMatch: ["**/loader-hmr.test.ts", "**/refresh-cmd.test.ts"],
          use: browserConfig,
          fullyParallel: false,
          dependencies: process.env.CI ? [] : ["hmr-client"],
        },
        {
          name: "hmr-routes",
          // Route-types HMR modifies route definition files — must not
          // overlap with intercept-hmr which expects routes to be intact.
          testMatch: "**/route-types-hmr.test.ts",
          use: browserConfig,
          fullyParallel: false,
          dependencies: process.env.CI ? [] : ["hmr-loader"],
        },
        {
          name: "hmr-intercept",
          // Intercept HMR modifies the intercept config file. Runs after
          // route-types HMR to avoid file-modification conflicts.
          testMatch: "**/intercept-hmr*.test.ts",
          use: browserConfig,
          fullyParallel: false,
          dependencies: process.env.CI ? [] : ["hmr-routes"],
        },
        {
          name: "webkit-smoke",
          testMatch: "**/smoke.test.ts",
          use: webkitConfig,
          // Run after the build completes to avoid resource contention.
          // Does not depend on dev/production to avoid being blocked by
          // flaky dev tests.
          dependencies: ["build"],
        },
      ],
  workers: 3,
  forbidOnly: !!process.env.CI,
  retries: 2,
  reporter: [
    ["list"],
    ...(process.env.CI ? [["github"], ["html", { open: "never" }]] : []),
  ] as import("@playwright/test").ReporterDescription[],
});
