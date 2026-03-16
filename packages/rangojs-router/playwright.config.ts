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

const isUIMode = process.argv.includes("--ui");

export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  globalTimeout: 600000, // 10 minutes max
  timeout: process.env.CI ? 60000 : 30000, // 60s on CI, 30s locally
  webServer: {
    // Build first (for production tests), then clean optimizer cache and start
    // dev server. Building before the dev server prevents `vite build` from
    // overwriting the running server's optimizer cache (node_modules/.vite/deps).
    command: `pnpm build && rm -rf node_modules/.vite && pnpm dev --port ${DEV_SERVER_PORT}`,
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
          use: browserConfig,
          fullyParallel: false,
        },
        {
          name: "hmr-client",
          testMatch: "**/client-component-hmr.test.ts",
          use: browserConfig,
          fullyParallel: false,
        },
        {
          name: "hmr",
          testMatch: [
            "**/loader-hmr.test.ts",
            "**/route-types-hmr.test.ts",
            "**/intercept-hmr*.test.ts",
            "**/refresh-cmd.test.ts",
          ],
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
          use: browserConfig,
          // Run production tests serially to avoid port conflicts.
          // Each test file spins up its own preview server.
          fullyParallel: false,
          // CI startup flake has been isolated to preview-server readiness.
          // Keep production worker count aligned with the existing CI shard
          // throughput while the fixture improvements provide better diagnostics.
          workers: process.env.CI ? 3 : undefined,
          dependencies: ["build"],
        },
        {
          name: "hmr-client",
          testMatch: "**/client-component-hmr.test.ts",
          use: browserConfig,
          fullyParallel: false,
          dependencies: process.env.CI ? [] : ["dev", "production"],
        },
        {
          name: "hmr",
          // Only run HMR test files (loader-hmr and route-types-hmr modify server modules
          // that can corrupt RSC module state, so they run after hmr-client)
          testMatch: [
            "**/loader-hmr.test.ts",
            "**/route-types-hmr.test.ts",
            "**/intercept-hmr*.test.ts",
            "**/refresh-cmd.test.ts",
          ],
          use: browserConfig,
          // HMR tests modify files, run serially to avoid conflicts
          fullyParallel: false,
          dependencies: process.env.CI
            ? []
            : ["dev", "production", "hmr-client"],
        },
        {
          name: "webkit-smoke",
          testMatch: "**/smoke.test.ts",
          use: webkitConfig,
          // Run after the main suite to avoid resource contention with
          // Chrome-based dev/production tests sharing the dev server.
          dependencies: ["dev", "production"],
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
