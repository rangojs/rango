/**
 * Flight (RSC) test project for the mini app — real React Server Component
 * rendering via `@rangojs/router/testing/flight` under the `react-server`
 * condition. Modeled on the router package's own vitest.rsc.config.ts.
 *
 * `rangoTestAliases()` maps the bare `@rangojs/router` specifier to its
 * `index.rsc.ts` (real react-server impls) so a renderHandler'd action that reads
 * `cookies()` / `getRequestContext()` does not hit the throwing out-of-react-
 * server stub (see auth.rsc-test.tsx). The alias is exact (subpaths untouched),
 * so the pure-leaf Flight tests that import only `/testing/flight` are unaffected.
 */
import { defineConfig } from "vitest/config";
import { rangoTestAliases } from "@rangojs/router/testing/vitest";

process.env.NODE_ENV = "production";

export default defineConfig({
  resolve: {
    conditions: ["react-server"],
    alias: rangoTestAliases(),
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
