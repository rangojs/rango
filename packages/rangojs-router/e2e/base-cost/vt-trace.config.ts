// Measurement fixture, not for merge.
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "vt-trace.recorder.ts",
  workers: 1,
  fullyParallel: false,
  timeout: 0,
  reporter: "line",
  use: {
    ...devices["Desktop Chrome"],
    viewport: null,
    deviceScaleFactor: undefined,
    baseURL: process.env.BASE,
  },
});
