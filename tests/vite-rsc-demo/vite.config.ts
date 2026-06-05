import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";
import { defineConfig } from "vite";
import path from "path";
import { rango } from "@rangojs/router/vite";
import devtoolsJson from "vite-plugin-devtools-json";

export default defineConfig({
  plugins: [
    react(),
    // React Compiler per the @vitejs/plugin-rsc example: plugin-react v6 runs
    // oxc (no internal Babel), so the compiler is a separate top-level
    // @rolldown/plugin-babel ordered after react() and before rango() (which
    // supplies @vitejs/plugin-rsc). reactCompilerPreset() gates itself via
    // applyToEnvironmentHook (consumer === "client"), so it compiles client
    // components only; ssr/rsc are left untouched (matches the upstream example).
    babel({ presets: [reactCompilerPreset()] }),
    rango({
      router: "./src/router.tsx",
      // Uses virtual entries by default (no explicit entries needed)
      //
      // Benchmark affordance (and a live demo of the public opt-out): the
      // cost-side benchmark builds this app both ways to compare per-route
      // splitting against the single-chunk baseline. RANGO_BENCH_CHUNKS=off
      // exercises `clientChunks: false`; unset uses the default-on strategy.
      // This is exactly the one-line opt-out a consumer would write.
      clientChunks:
        process.env.RANGO_BENCH_CHUNKS === "off" ? false : undefined,
    }),
    devtoolsJson(),
  ],
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
});
