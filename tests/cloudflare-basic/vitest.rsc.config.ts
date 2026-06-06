/**
 * Flight (RSC) test project for cloudflare-basic — real React Server Component
 * rendering via `@rangojs/router/testing/flight`.
 *
 * Real Flight rendering needs the `react-server` export condition, which flips
 * React to its server build (no client hooks). That MUST be isolated in its own
 * project. Note: this project does NOT use the `@rangojs/router/testing/vitest`
 * preset — that preset aliases `@rangojs/router` to real impls for the client
 * React build, which would crash under the server React build here. Flight tests
 * cover pure leaf server components (the documented v1 scope), so they need no
 * router alias. Modeled on the router package's own vitest.rsc.config.ts.
 */
import { defineConfig } from "vitest/config";
import { rangoUseClientTransform } from "@rangojs/router/testing/vitest";

// Force production React in this process and any forked worker (forks inherit
// process.env). Dev NODE_ENV crashes the bare worker (uninitialized owner-stack
// machinery) and emits volatile debug rows that defeat stable Flight snapshots.
process.env.NODE_ENV = "production";

export default defineConfig({
  // The "use client" transform lets renderServerTree resolve client islands
  // from the server tree's own imports (no clientComponents). Server components
  // are untouched, so renderToFlightString of leaf trees is unaffected.
  plugins: [rangoUseClientTransform()],
  resolve: {
    conditions: ["react-server"],
  },
  test: {
    globals: true,
    include: ["test/**/*.rsc-test.{ts,tsx}"],
    exclude: ["node_modules", "dist", "e2e"],
    pool: "forks",
    execArgv: ["--conditions=react-server"],
  },
});
