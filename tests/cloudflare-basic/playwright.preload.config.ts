import { defineConfig, devices } from "@playwright/test";
import { checkoutPortOffset } from "@shared/e2e";

const PORT_OFFSET = checkoutPortOffset();
const DEV_PORT = 5318 + PORT_OFFSET;
const PREVIEW_PORT = 5319 + PORT_OFFSET;
const CACHE_DIR = "node_modules/.vite-cloudflare-basic-preload";
const SERVER_ENV = {
  ...process.env,
  RANGO_E2E_HEAD_SCRIPTS: "preload",
  RANGO_E2E_VITE_CACHE_DIR: CACHE_DIR,
  RANGO_MANIFEST_TEXT: "1",
  RANGO_E2E_RENDER_TIMEOUT: "1",
};
const browserConfig = { ...devices["Desktop Chrome"] };

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : 2,
  reporter: [
    ["list"],
    ...(process.env.CI ? [["github"], ["html", { open: "never" }]] : []),
  ] as import("@playwright/test").ReporterDescription[],
  globalTimeout: process.env.CI ? 14 * 60 * 1000 : undefined,
  timeout: process.env.CI ? 60_000 : 30_000,
  use: {
    trace: "on-first-retry",
    actionTimeout: process.env.CI ? 30_000 : 15_000,
  },
  webServer: [
    {
      command: `pnpm build && rm -rf ${CACHE_DIR} && pnpm dev --port ${DEV_PORT}`,
      cwd: ".",
      port: DEV_PORT,
      reuseExistingServer: false,
      env: SERVER_ENV,
    },
    {
      command: `pnpm preview --port ${PREVIEW_PORT}`,
      cwd: ".",
      port: PREVIEW_PORT,
      reuseExistingServer: false,
      env: SERVER_ENV,
    },
  ],
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
});
