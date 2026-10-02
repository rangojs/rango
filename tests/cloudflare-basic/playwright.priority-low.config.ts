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
const DEV_PORT = 5348 + PORT_OFFSET;
const PREVIEW_PORT = 5349 + PORT_OFFSET;
const CACHE_DIR = "node_modules/.vite-cloudflare-basic-priority-low";
const SERVER_ENV = {
  ...process.env,
  RANGO_E2E_HEAD_SCRIPTS: "priority-low",
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
  // vite directly, not `pnpm <script>` (see playwright.config.ts, issue #886).
  webServer: [
    {
      command: `./node_modules/.bin/vite build && rm -rf ${CACHE_DIR} && ./node_modules/.bin/vite dev --port ${DEV_PORT}`,
      cwd: ".",
      port: DEV_PORT,
      reuseExistingServer: false,
      env: SERVER_ENV,
    },
    {
      command: `./node_modules/.bin/vite preview --port ${PREVIEW_PORT}`,
      cwd: ".",
      port: PREVIEW_PORT,
      reuseExistingServer: false,
      env: SERVER_ENV,
    },
  ],
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
});
