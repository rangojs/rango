import { defineConfig } from "vite";
import path from "path";
import { rango } from "@rangojs/router/vite";
import { analyze } from "../../../../tools/bundle-analyze";
import { productionDefines } from "../../../../tools/vite-define";

export default defineConfig(({ command }) => ({
  cacheDir:
    process.env.RANGO_E2E_VITE_CACHE_DIR ?? "node_modules/.vite-e2e-mini",
  // clientChunks defaults to on, so plain rango() splits app "use client"
  // components by route id. The /widgets and /charts routes (route-colocated
  // components + CSS, plus a same-named nested components/Badge.tsx each) exercise
  // the DEFAULT and are asserted in mini.test.ts + the build-graph test.
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
