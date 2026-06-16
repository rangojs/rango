import { defineConfig } from "vite";
import path from "node:path";
import react from "@vitejs/plugin-react";
import { rango } from "@rangojs/router/vite";

// Node preset (the default). Vercel runs Node Functions, not Workers, so this is
// the right base; the .vercel/output directory is assembled from dist/ by
// scripts/vercel-build.mjs after the build.
export default defineConfig(({ command }) => ({
  plugins: [react(), rango()],
  // Fold NODE_ENV at build time so React's CJS dev branch is dropped from the
  // SSR/RSC bundles. The Cloudflare plugin does this automatically; vanilla vite
  // build does not for SSR/RSC. Required by CLAUDE.md Bundle Hygiene rule #2.
  // Only the exact `process.env.NODE_ENV` token is replaced; `process.env.VERCEL`
  // and friends stay runtime lookups (resolved on the server at request time).
  define:
    command === "build"
      ? { "process.env.NODE_ENV": JSON.stringify("production") }
      : undefined,
  build: { sourcemap: true },
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "./src") } },
}));
