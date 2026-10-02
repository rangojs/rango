import { defineConfig, devices } from "@playwright/test";
import { checkoutPortOffset } from "@shared/e2e";

// The app built with the opt-in
// rango({ headScripts: { mode: "preinit", fetchPriority: "low" } })
// (RANGO_E2E_HEAD_SCRIPTS=priority-low). The default ("auto", no attribute)
// is asserted by e2e/head-script-preinit.test.ts under the main config.
// priority-low-production depends on priority-low-dev, so CI runs the whole
// config as ONE job (`--project=priority-low-production`, deps included):
// one build for both modes.

const PORT_OFFSET = checkoutPortOffset();
const DEV_PORT = 5338 + PORT_OFFSET;
const PREVIEW_PORT = 5339 + PORT_OFFSET;
const CACHE_DIR = "node_modules/.vite-e2e-test-app-priority-low";
const SERVER_ENV = {
  ...process.env,
  RANGO_E2E_HEAD_SCRIPTS: "priority-low",
  RANGO_E2E_VITE_CACHE_DIR: CACHE_DIR,
};
const browserConfig = {
  ...devices["Desktop Chrome"],
  viewport: null,
  deviceScaleFactor: undefined,
};

export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  globalTimeout: process.env.CI ? 10 * 60 * 1000 : undefined,
  timeout: process.env.CI ? 60_000 : 30_000,
  // vite directly, not `pnpm <script>` (see playwright.config.ts, issue #886).
  webServer: [
    {
      command: `./node_modules/.bin/vite build && rm -rf ${CACHE_DIR} && ./node_modules/.bin/vite --port ${DEV_PORT}`,
      cwd: "./e2e/test-app",
      port: DEV_PORT,
      reuseExistingServer: false,
      env: SERVER_ENV,
    },
    {
      command: `./node_modules/.bin/vite preview --port ${PREVIEW_PORT}`,
      cwd: "./e2e/test-app",
      port: PREVIEW_PORT,
      reuseExistingServer: false,
      env: SERVER_ENV,
    },
  ],
  use: {
    screenshot: "only-on-failure",
    trace: "on-all-retries",
  },
  expect: {
    timeout: 10_000,
    toPass: { timeout: 10_000 },
  },
  projects: [
    {
      name: "priority-low-dev-warmup",
      testMatch: "**/head-script-variant-warmup.setup.ts",
      use: {
        ...browserConfig,
        baseURL: `http://localhost:${DEV_PORT}`,
      },
    },
    {
      name: "priority-low-dev",
      testMatch: "**/head-script-priority-low.test.ts",
      grep: /^(?!.*\(production\))/,
      use: {
        ...browserConfig,
        baseURL: `http://localhost:${DEV_PORT}`,
      },
      dependencies: ["priority-low-dev-warmup"],
    },
    {
      name: "priority-low-production",
      testMatch: "**/head-script-priority-low.test.ts",
      grep: /\(production\)/,
      use: {
        ...browserConfig,
        baseURL: `http://localhost:${PREVIEW_PORT}`,
      },
      dependencies: ["priority-low-dev"],
    },
  ],
  workers: 2,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: [
    ["list"],
    ...(process.env.CI ? [["github"], ["html", { open: "never" }]] : []),
  ] as import("@playwright/test").ReporterDescription[],
});
