import { defineConfig } from "vite";
import path from "path";
import { rango } from "@rangojs/router/vite";
import { analyze } from "../../../../tools/bundle-analyze";
import { productionDefines } from "../../../../tools/vite-define";

export default defineConfig(({ command }) => ({
  cacheDir:
    process.env.RANGO_E2E_VITE_CACHE_DIR ?? "node_modules/.vite-e2e-mini",
  plugins: [rango(), ...analyze()],
  define: productionDefines(command),
  oxc: {
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
