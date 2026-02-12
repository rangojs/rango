import { defineConfig, devices } from "@playwright/test";

const isUIMode = process.argv.includes("--ui");

export default defineConfig({
  testDir: "./e2e",
  // Run tests serially since cloudflare dev server has port conflicts when running in parallel
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // Use single worker to avoid multiple dev server instances
  workers: 1,
  reporter: "html",
  // Global timeout to prevent hanging
  globalTimeout: process.env.CI ? 10 * 60 * 1000 : undefined, // 10 min on CI
  // Extended timeout for CI where workerd startup can be slow
  timeout: process.env.CI ? 60000 : 30000,
  use: {
    trace: "on-first-retry",
    // Extended action timeout for CI
    actionTimeout: process.env.CI ? 30000 : 15000,
  },
  // In UI mode, flatten projects to avoid the dependency chain that breaks
  // Playwright's --ui filtering (--grep, --project, file args).
  projects: isUIMode
    ? [
        {
          name: "dev",
          grep: /^(?!.*\(production\))/,
          testIgnore: ["**/hmr.test.ts", "**/*.setup.ts"],
          use: { ...devices["Desktop Chrome"] },
        },
        {
          name: "production",
          grep: /\(production\)/,
          testIgnore: ["**/*.setup.ts"],
          use: { ...devices["Desktop Chrome"] },
        },
        {
          name: "hmr",
          testMatch: ["**/hmr.test.ts"],
          use: { ...devices["Desktop Chrome"] },
        },
      ]
    : [
        {
          name: "build",
          testMatch: "**/build-test-app.setup.ts",
        },
        {
          name: "dev",
          grep: /^(?!.*\(production\))/,
          testIgnore: ["**/hmr.test.ts", "**/*.setup.ts"],
          use: { ...devices["Desktop Chrome"] },
        },
        {
          name: "production",
          grep: /\(production\)/,
          testIgnore: ["**/*.setup.ts"],
          use: { ...devices["Desktop Chrome"] },
          dependencies: ["build"],
        },
        {
          name: "hmr",
          testMatch: ["**/hmr.test.ts"],
          use: { ...devices["Desktop Chrome"] },
        },
      ],
});
