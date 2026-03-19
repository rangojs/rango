import { defineConfig } from "vite";
import { rango } from "@rangojs/router/vite";

export default defineConfig({
  cacheDir:
    process.env.RANGO_E2E_VITE_CACHE_DIR ?? "node_modules/.vite-e2e-timeout",
  plugins: [rango()],
  esbuild: {
    target: "es2022",
  },
  build: {
    sourcemap: true,
  },
  resolve: {
    dedupe: ["react", "react-dom"],
  },
});
