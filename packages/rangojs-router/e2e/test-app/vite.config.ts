import { defineConfig } from "vite";
import path from "path";
import react from "@vitejs/plugin-react";
import { rango, poke } from "@rangojs/router/vite";
import devtoolsJson from "vite-plugin-devtools-json";

export default defineConfig({
  cacheDir:
    process.env.RANGO_E2E_VITE_CACHE_DIR ?? "node_modules/.vite-e2e-test-app",
  plugins: [react(), rango(), devtoolsJson(), poke()],
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
});
