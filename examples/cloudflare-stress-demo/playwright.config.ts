import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: [
    ["list"],
    ...(process.env.CI ? [["github" as const], ["html" as const, { open: "never" }]] : []),
  ],
  timeout: process.env.CI ? 120000 : 60000,
  projects: [
    {
      name: "build",
      testMatch: "**/build.setup.ts",
    },
    {
      name: "production",
      testIgnore: ["**/*.setup.ts"],
      dependencies: ["build"],
    },
  ],
});
