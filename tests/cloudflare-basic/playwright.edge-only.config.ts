import { defineConfig, devices } from "@playwright/test";
import { checkoutPortOffset } from "@shared/e2e";

// Edge-only ppr shells: RANGO_E2E_EDGE_ONLY_CACHE=1 makes src/router.tsx drop
// the KV binding from the app-level CFCacheStore (define-inlined by
// vite.config.ts), so shells run L1-only on the Cache API. That is a
// config-level store change — it would rewrite what every KV-backed suite in
// the main config pins — so it gets its own servers + build, same pattern as
// playwright.preload.config.ts.
const PORT_OFFSET = checkoutPortOffset();
const DEV_PORT = 5328 + PORT_OFFSET;
const PREVIEW_PORT = 5329 + PORT_OFFSET;
const CACHE_DIR = "node_modules/.vite-cloudflare-basic-edge-only";
const SERVER_ENV = {
  ...process.env,
  RANGO_E2E_EDGE_ONLY_CACHE: "1",
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
      name: "edge-only-dev-warmup",
      testMatch: "**/edge-only-ppr-warmup.setup.ts",
      use: {
        ...browserConfig,
        baseURL: `http://localhost:${DEV_PORT}`,
      },
    },
    {
      name: "edge-only-dev",
      testMatch: "**/edge-only-ppr.test.ts",
      grep: /^(?!.*\(production\))/,
      use: {
        ...browserConfig,
        baseURL: `http://localhost:${DEV_PORT}`,
      },
      dependencies: ["edge-only-dev-warmup"],
    },
    {
      name: "edge-only-production",
      testMatch: "**/edge-only-ppr.test.ts",
      grep: /\(production\)/,
      use: {
        ...browserConfig,
        baseURL: `http://localhost:${PREVIEW_PORT}`,
      },
    },
  ],
});
