/**
 * Unit / integration / DOM test project for cloudflare-basic — the dogfood of
 * `@rangojs/router/testing` against a real Cloudflare consumer app.
 *
 * The alias setup that makes the app's own router/loaders/middleware importable
 * in a bare Vitest process is provided by the official preset
 * `@rangojs/router/testing/vitest` (see that module for the why). `cloudflare:
 * true` adds the Cloudflare runtime virtual stubs the route tree imports.
 *
 * Flight (RSC) tests live in vitest.rsc.config.ts (the `react-server` condition).
 */
import { defineConfig } from "vitest/config";
import { rangoTestAliases } from "@rangojs/router/testing/vitest";

export default defineConfig({
  test: {
    globals: true,
    include: ["test/**/*.{test,spec}.{ts,tsx}"],
    exclude: ["node_modules", "dist", "e2e", "test/**/*.rsc-test.*"],
    environment: "node",
  },
  resolve: {
    alias: rangoTestAliases({ cloudflare: true }),
  },
});
