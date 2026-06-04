import { defineConfig } from "vite";
import path from "path";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";
import { rango } from "@rangojs/router/vite";
import { analyze } from "../../../../tools/bundle-analyze";
import { productionDefines } from "../../../../tools/vite-define";

export default defineConfig(({ command }) => ({
  cacheDir:
    process.env.RANGO_E2E_VITE_CACHE_DIR ?? "node_modules/.vite-e2e-basic",
  // React Compiler wiring per the @vitejs/plugin-rsc example: plugin-react v6
  // runs oxc (no internal Babel), so the compiler is a separate top-level
  // @rolldown/plugin-babel ordered after react() and before rango() (which
  // supplies @vitejs/plugin-rsc). reactCompilerPreset() gates itself via
  // applyToEnvironmentHook (consumer === "client"), so it compiles client
  // components only; ssr/rsc are left untouched (matches the upstream example).
  plugins: [
    react(),
    babel({ presets: [reactCompilerPreset()] }),
    rango(),
    ...analyze(),
  ],
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
