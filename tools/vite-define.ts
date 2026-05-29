/**
 * Production-mode `define` entries for Vite's constant folding.
 *
 * React's CJS files use `if (process.env.NODE_ENV !== "production") { ...dev... }`.
 * If the conditional isn't folded at build time the minifier keeps both branches,
 * doubling React's footprint in SSR/RSC. The Cloudflare vite plugin folds NODE_ENV
 * automatically; vanilla `vite build` folds for client but not always for SSR/RSC.
 *
 * Bundle guard: `packages/rangojs-router/e2e/build-test-app.setup.ts` walks
 * `dist/` after every production build and fails if any `react*.development*.js`
 * chunk appears. See AGENTS.md § Bundle Hygiene for the full rule.
 */
export function productionDefines(
  command: "build" | "serve",
): Record<string, string> | undefined {
  return command === "build"
    ? { "process.env.NODE_ENV": JSON.stringify("production") }
    : undefined;
}
