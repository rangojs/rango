import { defineConfig } from "@playwright/test";

const DEV_PORT = 5198;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: [
    ["list"],
    ...(process.env.CI ? [["github"], ["html", { open: "never" }]] : []),
  ] as import("@playwright/test").ReporterDescription[],
  timeout: process.env.CI ? 60000 : 30000,
  webServer: {
    command: `pnpm build && pnpm dev --port ${DEV_PORT}`,
    port: DEV_PORT,
    reuseExistingServer: !process.env.CI,
  },
  projects: [
    {
      name: "dev",
      use: { baseURL: `http://localhost:${DEV_PORT}` },
    },
  ],
});
