import { defineConfig, devices } from "@playwright/test";

const isUIMode = process.argv.includes("--ui");

const DEV_PORT = 5199;
const PREVIEW_PORT = 5198;

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
  // 14m (was 10m): the merged PPR shell stack grew the sequential
  // dev -> production -> hmr run past the old 10m on CI (and the ppr
  // dev-warmup adds dev-time work), so healthy runs brushed the cap and any
  // flake retry tipped it over — Playwright then killed the run mid-flight,
  // failing whichever test was executing ("Timed out waiting 600s for the
  // test suite to run"). 14m playwright budget + ~3-4m of job setup (install,
  // router build, browser deps) fits inside the workflow job's
  // timeout-minutes: 20 cap (.github/workflows/e2e.yml).
  globalTimeout: process.env.CI ? 14 * 60 * 1000 : undefined,
  timeout: process.env.CI ? 60000 : 30000,
  use: {
    trace: "on-first-retry",
    actionTimeout: process.env.CI ? 30000 : 15000,
  },
  webServer: [
    {
      // Build first so dist/ is ready for production tests and deps_ssr is
      // populated before the dev server starts (wrangler's module runner does
      // not recover from ERR_OUTDATED_OPTIMIZED_DEP if the build runs later).
      command: `pnpm build && rm -rf node_modules/.vite && pnpm dev --port ${DEV_PORT}`,
      port: DEV_PORT,
      reuseExistingServer: true,
    },
    {
      // Shared preview server for all production tests. Started after the dev
      // server (which includes the build step) so dist/ is guaranteed to exist.
      command: `pnpm preview --port ${PREVIEW_PORT}`,
      port: PREVIEW_PORT,
      reuseExistingServer: true,
    },
  ],
  // In UI mode, flatten projects to avoid the dependency chain that breaks
  // Playwright's --ui filtering (--grep, --project, file args).
  projects: isUIMode
    ? [
        {
          name: "dev",
          grep: /^(?!.*\(production\))/,
          testIgnore: ["**/hmr*.test.ts", "**/*.setup.ts"],
          use: {
            ...devices["Desktop Chrome"],
            baseURL: `http://localhost:${DEV_PORT}`,
          },
        },
        {
          name: "production",
          grep: /\(production\)/,
          testIgnore: ["**/*.setup.ts"],
          use: {
            ...devices["Desktop Chrome"],
            baseURL: `http://localhost:${PREVIEW_PORT}`,
          },
        },
        {
          name: "hmr",
          testMatch: ["**/hmr*.test.ts"],
          use: { ...devices["Desktop Chrome"] },
          fullyParallel: false,
        },
      ]
    : [
        {
          name: "dev-warmup",
          testMatch: "**/dev-warmup.setup.ts",
          use: {
            ...devices["Desktop Chrome"],
            baseURL: `http://localhost:${DEV_PORT}`,
          },
        },
        {
          name: "dev",
          grep: /^(?!.*\(production\))/,
          testIgnore: ["**/hmr*.test.ts", "**/*.setup.ts"],
          use: {
            ...devices["Desktop Chrome"],
            baseURL: `http://localhost:${DEV_PORT}`,
          },
          dependencies: ["dev-warmup"],
        },
        {
          name: "production",
          grep: /\(production\)/,
          testIgnore: ["**/*.setup.ts"],
          use: {
            ...devices["Desktop Chrome"],
            baseURL: `http://localhost:${PREVIEW_PORT}`,
          },
          fullyParallel: false,
          timeout: 60000,
          dependencies: ["dev"],
        },
        {
          name: "hmr",
          testMatch: ["**/hmr*.test.ts"],
          use: { ...devices["Desktop Chrome"] },
          fullyParallel: false,
          dependencies: ["dev", "production"],
        },
      ],
});
