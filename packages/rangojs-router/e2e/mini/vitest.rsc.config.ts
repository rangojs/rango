/**
 * Flight (RSC) test project for the mini app — real React Server Component
 * rendering via `@rangojs/router/testing/flight` under the `react-server`
 * condition. Pure leaf server components only (no router alias). Modeled on the
 * router package's own vitest.rsc.config.ts.
 */
import { defineConfig } from "vitest/config";

process.env.NODE_ENV = "production";

export default defineConfig({
  resolve: {
    conditions: ["react-server"],
  },
  test: {
    globals: true,
    include: ["test/**/*.rsc-test.{ts,tsx}"],
    exclude: ["node_modules", "dist"],
    pool: "forks",
    execArgv: ["--conditions=react-server"],
    // @rangojs/router ships as TS source; force Vite (not Node) to transpile it
    // so an installed consumer on Node >= 23 does not hit type-stripping errors.
    // No-op in this monorepo (workspace symlink resolves outside node_modules).
    // Mirrors rangoInlineDeps from @rangojs/router/testing/vitest.
    server: { deps: { inline: [/@rangojs[/\\]router/] } },
  },
});
