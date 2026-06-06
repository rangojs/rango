/**
 * Flight (RSC) test project for cloudflare-basic — real React Server Component
 * rendering via `@rangojs/router/testing/flight`.
 *
 * Real Flight rendering needs the `react-server` export condition, which flips
 * React to its server build (no client hooks). That MUST be isolated in its own
 * project.
 *
 * It ALSO needs the bare `@rangojs/router` -> `index.rsc.ts` alias (from
 * `rangoTestAliases`): a rendered handler (or server component) that imports
 * `getRequestContext()` / `cookies()` from the bare specifier resolves to the
 * OUT-of-react-server stub (which throws) when only `resolve.conditions` is set —
 * Vite does not reliably apply the condition to bare-package export resolution.
 * The alias points at `index.rsc.ts`, which IS the react-server build (real
 * impls), so it does NOT conflict with the server React build here. (Pure leaf
 * server components — `renderServerTree` of a tree that never reads the request
 * context — work without the alias, which is why earlier Flight tests omitted it.)
 */
import { defineConfig } from "vitest/config";
import {
  rangoTestAliases,
  rangoUseClientTransform,
} from "@rangojs/router/testing/vitest";

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
    // Bare @rangojs/router -> index.rsc.ts (real react-server impls), so a
    // rendered handler reading getRequestContext()/cookies() does not hit the
    // throwing out-of-react-server stub. preset: "cloudflare" also stubs the
    // cloudflare:* runtime virtuals.
    alias: rangoTestAliases({ preset: "cloudflare" }),
  },
  test: {
    globals: true,
    include: ["test/**/*.rsc-test.{ts,tsx}"],
    exclude: ["node_modules", "dist", "e2e"],
    pool: "forks",
    execArgv: ["--conditions=react-server"],
  },
});
