import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import path from "path";
import { rango } from "@rangojs/router/vite";
import devtoolsJson from "vite-plugin-devtools-json";

export default defineConfig({
  plugins: [
    // React Compiler via plugin-react's native option; compiles client components only.
    react({ compiler: true }),
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
