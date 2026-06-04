import { defineConfig } from "vite";
import { rango } from "@rangojs/router/vite";

// Plain-JavaScript Vite config (vite.config.js, not .ts). The rango plugin
// auto-discovers the router (the single createRouter, in src/router.jsx) and
// provides the client/server entries, so no index.html, entry files, or
// explicit router config are needed.
export default defineConfig(({ command }) => ({
  plugins: [rango()],
  // Per-server Vite cache dir, set by the dev fixture (RANGO_NOTS_VITE_CACHE_DIR)
  // so concurrent worker-scoped dev servers each optimize into their own
  // directory instead of racing on node_modules/.vite/deps_rsc temp renames
  // (ENOTEMPTY). Unset for `pnpm dev`/`pnpm build`, where Vite's default is used.
  cacheDir: process.env.RANGO_NOTS_VITE_CACHE_DIR || undefined,
  // Bind a concrete host in tests (RANGO_NOTS_HOST=127.0.0.1, set by the e2e
  // fixtures) so the server's printed origin is an unambiguous IPv4 address and
  // tests connect to exactly the listener it bound. Unset for human
  // `pnpm dev`/`pnpm preview`, where Vite's default host is used.
  server: { host: process.env.RANGO_NOTS_HOST || undefined },
  preview: { host: process.env.RANGO_NOTS_HOST || undefined },
  // Fold NODE_ENV at build time so React's CJS dev/prod branches collapse and
  // the production bundle does not ship react*.development chunks. Required for
  // non-Cloudflare apps (see AGENTS.md > Bundle Hygiene).
  define:
    command === "build"
      ? { "process.env.NODE_ENV": JSON.stringify("production") }
      : undefined,
  oxc: { target: "es2022" },
  build: { sourcemap: true },
}));
