import { defineConfig } from "vite";
import path from "path";
import react from "@vitejs/plugin-react";
import { rango, poke } from "@rangojs/router/vite";
import devtoolsJson from "vite-plugin-devtools-json";
import { analyze } from "../../../../tools/bundle-analyze";

export default defineConfig(({ command }) => ({
  cacheDir:
    process.env.RANGO_E2E_VITE_CACHE_DIR ?? "node_modules/.vite-e2e-test-app",
  plugins: [react(), rango(), devtoolsJson(), poke(), ...analyze()],
  // For build, fold process.env.NODE_ENV so React's CJS files emit only the
  // .production.js variants. Without this, SSR/RSC bundles ship both
  // .development.js and .production.js copies of react-dom-server etc.
  // Cloudflare's vite plugin does this for CF apps; for plain vite-rsc apps
  // we set it here.
  define:
    command === "build"
      ? { "process.env.NODE_ENV": JSON.stringify("production") }
      : undefined,
  esbuild: {
    target: "es2022",
  },
  build: {
    sourcemap: true,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
}));
