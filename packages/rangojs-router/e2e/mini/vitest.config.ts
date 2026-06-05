/**
 * Unit / integration / DOM test project for the mini app — dogfood of
 * `@rangojs/router/testing` against a small, node-preset Rango app. The alias
 * setup is the official preset `@rangojs/router/testing/vitest`. Mini has no
 * Prerender, so the full router imports cleanly (enabling a whole-app
 * generated-routes drift check + dispatch against real routes).
 */
import { defineConfig } from "vitest/config";
import { rangoTestConfig } from "@rangojs/router/testing/vitest";

export default defineConfig({
  test: {
    globals: true,
    include: ["test/**/*.{test,spec}.{ts,tsx}"],
    exclude: ["node_modules", "dist", "test/**/*.rsc-test.*"],
    environment: "node",
    ...rangoTestConfig(),
  },
});
