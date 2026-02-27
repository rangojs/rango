import { defineConfig, devices } from "@playwright/test";

const browserConfig = {
  ...devices["Desktop Chrome"],
  viewport: null,
  deviceScaleFactor: undefined,
};

const DEV_SERVER_PORT = 5288;

const isUIMode = process.argv.includes("--ui");

// Tests that depend on CWD being packages/rangojs-router/ (CLI paths, build
// output file paths, or loader URLs with source-file references that break
// through symlinks). These test router internals, not Vite compatibility.
const CWD_DEPENDENT_TESTS = [
  "**/route-types.test.ts",
  "**/action-id-resolution.test.ts",
  "**/app-middleware.test.ts",
];

export default defineConfig({
  testDir: "../../packages/rangojs-router/e2e",
  fullyParallel: true,
  globalTimeout: 600000,
  timeout: process.env.CI ? 60000 : 30000,
  webServer: {
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
  projects: isUIMode
    ? [
        {
          name: "smoke",
          testMatch: "**/smoke.test.ts",
          use: browserConfig,
        },
        {
          name: "dev",
          grep: /^(?!.*\(production)/,
          testIgnore: [
            "**/smoke.test.ts",
            "**/loader-hmr.test.ts",
            "**/route-types-hmr.test.ts",
            "**/client-component-hmr.test.ts",
            "**/*.setup.ts",
            ...CWD_DEPENDENT_TESTS,
          ],
          use: {
            ...browserConfig,
            baseURL: `http://localhost:${DEV_SERVER_PORT}`,
          },
        },
        {
          name: "production",
          grep: /\(production/,
          testIgnore: ["**/smoke.test.ts", ...CWD_DEPENDENT_TESTS],
          use: browserConfig,
          fullyParallel: false,
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
          grep: /^(?!.*\(production)/,
          testIgnore: [
            "**/smoke.test.ts",
            "**/loader-hmr.test.ts",
            "**/route-types-hmr.test.ts",
            "**/client-component-hmr.test.ts",
            "**/*.setup.ts",
            ...CWD_DEPENDENT_TESTS,
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
          testIgnore: ["**/smoke.test.ts", ...CWD_DEPENDENT_TESTS],
          use: browserConfig,
          fullyParallel: false,
          dependencies: ["build"],
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
