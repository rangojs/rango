import { defineConfig } from "vite";
import { rango } from "@rangojs/router/vite";

export default defineConfig(({ command }) => ({
  cacheDir:
    process.env.RANGO_E2E_VITE_CACHE_DIR ?? "node_modules/.vite-e2e-timeout",
  plugins: [rango()],
  // For build, fold process.env.NODE_ENV so React's CJS files emit only the
  // .production.js variants. See e2e/test-app/vite.config.ts for full
  // explanation.
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
    dedupe: ["react", "react-dom"],
  },
}));
