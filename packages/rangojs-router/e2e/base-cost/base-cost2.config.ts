import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "base-cost2.recorder.ts",
  workers: 1,
  fullyParallel: false,
  timeout: 0,
  reporter: "line",
  use: {
    ...devices["Desktop Chrome"],
    viewport: null,
    deviceScaleFactor: undefined,
    baseURL: process.env.BASE ?? "http://localhost:47319",
  },
});
