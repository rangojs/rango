import { defineConfig } from "vitest/config";
import { resolve } from "path";

export default defineConfig({
  test: {
    globals: true,
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    exclude: ["node_modules", "dist", "e2e"],
  },
  resolve: {
    alias: {
      // Mock the virtual module for tests
      "rsc-router:version": resolve(__dirname, "src/__mocks__/version.ts"),
    },
  },
});
