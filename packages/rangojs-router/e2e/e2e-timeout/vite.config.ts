import { defineConfig } from "vite";
import { rango } from "@rangojs/router/vite";
import { productionDefines } from "../../../../tools/vite-define";

export default defineConfig(({ command }) => ({
  cacheDir:
    process.env.RANGO_E2E_VITE_CACHE_DIR ?? "node_modules/.vite-e2e-timeout",
  plugins: [rango()],
  define: productionDefines(command),
  oxc: {
    target: "es2022",
  },
  build: {
    sourcemap: true,
  },
}));
