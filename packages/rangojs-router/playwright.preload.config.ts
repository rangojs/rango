import { defineConfig, devices } from "@playwright/test";
import { checkoutPortOffset } from "@shared/e2e";

const PORT_OFFSET = checkoutPortOffset();
const DEV_PORT = 5308 + PORT_OFFSET;
const PREVIEW_PORT = 5309 + PORT_OFFSET;
const CACHE_DIR = "node_modules/.vite-e2e-test-app-preload";
const SERVER_ENV = {
  ...process.env,
  RANGO_E2E_HEAD_SCRIPTS: "preload",
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
  globalTimeout: 600_000,
  timeout: process.env.CI ? 60_000 : 30_000,
  webServer: [
    {
      command: `pnpm build && rm -rf ${CACHE_DIR} && pnpm dev --port ${DEV_PORT}`,
      cwd: "./e2e/test-app",
      port: DEV_PORT,
      reuseExistingServer: false,
      env: SERVER_ENV,
    },
    {
      command: `pnpm preview --port ${PREVIEW_PORT}`,
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
      name: "preload-dev-warmup",
      testMatch: "**/head-script-preload-warmup.setup.ts",
      use: {
        ...browserConfig,
        baseURL: `http://localhost:${DEV_PORT}`,
      },
    },
    {
      name: "preload-dev",
      testMatch: "**/head-script-preload.test.ts",
      grep: /^(?!.*\(production\))/,
      use: {
        ...browserConfig,
        baseURL: `http://localhost:${DEV_PORT}`,
      },
      dependencies: ["preload-dev-warmup"],
    },
    {
      name: "preload-production",
      testMatch: "**/head-script-preload.test.ts",
      grep: /\(production\)/,
      use: {
        ...browserConfig,
        baseURL: `http://localhost:${PREVIEW_PORT}`,
      },
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
