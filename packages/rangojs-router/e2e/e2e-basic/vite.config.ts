import { defineConfig } from "vite";
import path from "path";
import react from "@vitejs/plugin-react";
import { rango } from "@rangojs/router/vite";
import { analyze } from "../../../../tools/bundle-analyze";
import { productionDefines } from "../../../../tools/vite-define";

export default defineConfig(({ command }) => ({
  cacheDir:
    process.env.RANGO_E2E_VITE_CACHE_DIR ?? "node_modules/.vite-e2e-basic",
  // React Compiler via plugin-react's native option; compiles client components only.
  plugins: [react({ compiler: true }), rango(), ...analyze()],
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
