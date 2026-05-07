import { defineConfig } from "vite";
import path from "path";
import { rango } from "@rangojs/router/vite";
import { analyze } from "../../../../tools/bundle-analyze";

export default defineConfig({
  cacheDir:
    process.env.RANGO_E2E_VITE_CACHE_DIR ?? "node_modules/.vite-e2e-basic",
  plugins: [rango(), ...analyze()],
  esbuild: {
    target: "es2022",
  },
  build: {
    sourcemap: true,
  },
  resolve: {
    dedupe: ["react", "react-dom"],
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
