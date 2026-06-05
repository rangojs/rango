/**
 * Unit / integration / DOM test project for vite-rsc-demo — dogfood of
 * `@rangojs/router/testing` against a richer node-preset app (real exported
 * auth/logger middleware, loaders, revalidation, React Compiler). Alias setup is
 * the shipped preset. vite-rsc-demo uses Prerender (magazine), so the FULL
 * router can't be imported in a bare test — tests import leaf modules
 * (middleware fns, client components) and build small routers where needed.
 */
import { defineConfig } from "vitest/config";
import { rangoTestConfig } from "@rangojs/router/testing/vitest";

export default defineConfig({
  test: {
    globals: true,
    include: ["test/**/*.{test,spec}.{ts,tsx}"],
    exclude: ["node_modules", "dist", "e2e", "test/**/*.rsc-test.*"],
    environment: "node",
    ...rangoTestConfig(),
  },
});
