/**
 * Separate vitest project for REAL Flight (RSC) rendering tests.
 *
 * These tests render server components to Flight wire strings using the
 * vendored react-server-dom serializer, which requires the `react-server`
 * export condition. That condition flips React to its server build (no client
 * hooks), so it MUST live in its own project — the main vitest.config.ts must
 * NOT set it, or the ~50 tests that mock @vitejs/plugin-rsc/rsc would break.
 *
 * Run with:
 *   pnpm exec vitest run --config vitest.rsc.config.ts
 *
 * The `react-server` condition is forced two ways for robustness:
 *  1. resolve.conditions — applied by Vite's module resolver in this project.
 *  2. test.execArgv `--conditions=react-server` (Vitest 4 top-level pool
 *     option) — applied to the forked node worker so React's runtime detects
 *     the condition. Without it React throws
 *     "the react-server condition must be enabled".
 *
 * NODE_ENV is forced to "production" here (and inherited by the forked worker).
 * This is REQUIRED, not just recommended: under dev NODE_ENV the JSX dev
 * runtime (jsxDEV) crashes in this bare worker with
 * "Cannot read properties of undefined (reading 'recentlyCreatedOwnerStacks')"
 * because React's owner-stack dev machinery is not initialized. Production mode
 * also yields the cleanest, most stable Flight payloads for snapshots (no
 * `:N<timestamp>` row, no per-component stack/timing rows).
 *
 * If a future toolchain change stops propagating execArgv to the worker, the
 * fallback is to wrap the command:
 *   NODE_OPTIONS="--conditions=react-server" NODE_ENV=production \
 *     pnpm exec vitest run --config vitest.rsc.config.ts
 */

import { defineConfig } from "vitest/config";
import { resolve } from "path";

// Force production React in this process and any forked worker (forks inherit
// process.env). See header for why dev mode is not viable here.
process.env.NODE_ENV = "production";

export default defineConfig({
  resolve: {
    conditions: ["react-server"],
    alias: {
      // Mirror the main config: the version virtual module is build-only.
      "@rangojs/router:version": resolve(__dirname, "src/__mocks__/version.ts"),
    },
  },
  test: {
    globals: true,
    include: ["src/**/*.rsc-test.{ts,tsx}"],
    exclude: ["node_modules", "dist", "e2e"],
    // Vitest 4: pool config is top-level (poolOptions was removed). Force the
    // react-server condition on the forked worker so React's runtime detects it.
    pool: "forks",
    execArgv: ["--conditions=react-server"],
  },
});
