import { defineConfig } from "vitest/config";
import { resolve } from "path";

export default defineConfig({
  test: {
    globals: true,
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    exclude: ["node_modules", "dist", "e2e"],
    // The router's own tests run the dev suspense audit; a consumer's never
    // do (src/internal-suspense-audit.ts).
    env: { INTERNAL_RANGO_SUSPENSE_AUDIT: "1" },
  },
  resolve: {
    alias: {
      // Mock the virtual module for tests
      "@rangojs/router:version": resolve(__dirname, "src/__mocks__/version.ts"),
    },
  },
});
