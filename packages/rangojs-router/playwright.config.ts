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
// Host-router fixture servers (e2e/test-app/.host-fixture) for host-routing.test.ts.
const HOST_DEV_PORT = 5198;
const HOST_PREVIEW_PORT = 5199;

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
    {
      // Host-router fixture (e2e/test-app/.host-fixture), node preset. Dev server
      // for host-routing.test.ts "(dev)". Self-contained (vite dev generates its
      // own manifests).
      command: `pnpm host:dev --port ${HOST_DEV_PORT}`,
      cwd: "./e2e/test-app",
      port: HOST_DEV_PORT,
      reuseExistingServer: !process.env.CI,
    },
    {
      // Host-router fixture preview (built) for host-routing.test.ts
      // "(production)". Builds then serves the .vercel/output-equivalent node build.
      command: `pnpm host:build && pnpm host:preview --port ${HOST_PREVIEW_PORT}`,
      cwd: "./e2e/test-app",
      port: HOST_PREVIEW_PORT,
      reuseExistingServer: !process.env.CI,
    },
  ],
  use: {
    screenshot: "only-on-failure",
    trace: "on-all-retries",
  },
  expect: {
    timeout: 10000,
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
            "**/prerender-hmr.test.ts",
            "**/basename-hmr.test.ts",
            "**/refresh-cmd.test.ts",
            "**/*.setup.ts",
            // mini is a Vitest dogfood app nested under e2e/; its vitest
            // test/*.test.tsx files must not be collected by Playwright.
            "**/mini/**",
          ],
          use: {
            ...browserConfig,
            baseURL: `http://localhost:${DEV_SERVER_PORT}`,
          },
        },
        {
          name: "production",
          grep: /\(production/,
          testIgnore: ["**/smoke.test.ts", "**/mini/**"],
          use: {
            ...browserConfig,
            baseURL: `http://localhost:${PREVIEW_SERVER_PORT}`,
          },
          fullyParallel: false,
        },
        {
          name: "hmr-prerender",
          testMatch: "**/prerender-hmr.test.ts",
          use: browserConfig,
          fullyParallel: false,
          dependencies: ["dev"],
        },
        {
          name: "hmr-client",
          testMatch: "**/client-component-hmr.test.ts",
          use: browserConfig,
          fullyParallel: false,
          dependencies: ["dev"],
        },
        {
          name: "hmr-loader",
          testMatch: ["**/loader-hmr.test.ts", "**/refresh-cmd.test.ts"],
          use: browserConfig,
          fullyParallel: false,
          dependencies: ["dev"],
        },
        {
          name: "hmr-routes",
          testMatch: "**/route-types-hmr.test.ts",
          use: browserConfig,
          fullyParallel: false,
          dependencies: ["dev"],
        },
        {
          name: "hmr-intercept",
          testMatch: "**/intercept-hmr*.test.ts",
          use: browserConfig,
          fullyParallel: false,
          dependencies: ["dev"],
        },
        {
          name: "hmr-basename",
          testMatch: "**/basename-hmr.test.ts",
          use: browserConfig,
          fullyParallel: false,
          // Basename HMR modifies router.tsx to add basename: "/app",
          // which triggers route rediscovery and rewrites the gen file.
          // Must run after dev tests to avoid contaminating parallel tests.
          dependencies: ["dev"],
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
            "**/prerender-hmr.test.ts",
            "**/basename-hmr.test.ts",
            "**/refresh-cmd.test.ts",
            "**/*.setup.ts",
            // mini is a Vitest dogfood app nested under e2e/; its vitest
            // test/*.test.tsx files must not be collected by Playwright.
            "**/mini/**",
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
          testIgnore: ["**/smoke.test.ts", "**/mini/**"],
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
          // HMR tests modify route files in the shared test-app directory.
          // The dev server's Vite watcher picks up these changes, invalidating
          // modules and busting the in-memory cache — causing cache tests to fail.
          // Must run after dev tests complete.
          dependencies: ["dev"],
        },
        {
          name: "hmr-loader",
          testMatch: ["**/loader-hmr.test.ts", "**/refresh-cmd.test.ts"],
          use: browserConfig,
          fullyParallel: false,
          dependencies: ["dev", "hmr-client"],
        },
        {
          name: "hmr-routes",
          // Route-types HMR modifies route definition files — must not
          // overlap with intercept-hmr which expects routes to be intact.
          testMatch: "**/route-types-hmr.test.ts",
          use: browserConfig,
          fullyParallel: false,
          dependencies: ["dev", "hmr-loader"],
        },
        {
          name: "hmr-intercept",
          // Intercept HMR modifies the intercept config file. Runs after
          // route-types HMR to avoid file-modification conflicts.
          testMatch: "**/intercept-hmr*.test.ts",
          use: browserConfig,
          fullyParallel: false,
          dependencies: ["dev", "hmr-routes"],
        },
        {
          name: "hmr-basename",
          // Basename HMR modifies router.tsx to add basename: "/app",
          // which triggers route rediscovery and rewrites the gen file
          // with /app-prefixed routes. Must run after dev tests to avoid
          // contaminating parallel tests with the wrong route map.
          testMatch: "**/basename-hmr.test.ts",
          use: browserConfig,
          fullyParallel: false,
          dependencies: ["dev"],
        },
        {
          name: "hmr-prerender",
          // Local-only: tests skip on CI via test.skip(!!process.env.CI).
          testMatch: "**/prerender-hmr.test.ts",
          use: browserConfig,
          fullyParallel: false,
          dependencies: ["dev"],
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
