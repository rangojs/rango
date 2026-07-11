import { defineConfig } from "vite";
import path from "node:path";
import react from "@vitejs/plugin-react";
import { rango } from "@rangojs/router/vite";

// The vercel preset builds like the node preset (Vercel runs Node Functions, not
// Workers), folds NODE_ENV for the SSR/RSC build, and assembles .vercel/output
// (Build Output API v3) from dist/ after `vite build`.
export default defineConfig({
  plugins: [react(), rango({ preset: "vercel" })],
  build: { sourcemap: true },
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "./src") } },
  // Fold the e2e gates at build time so neither test endpoint nor the local
  // Runtime Cache handle can be enabled in a deployed function at runtime.
  define: {
    "process.env.RANGO_TRACE_DEBUG": JSON.stringify(
      process.env.RANGO_TRACE_DEBUG ?? "",
    ),
    "process.env.RANGO_VERCEL_CACHE_E2E": JSON.stringify(
      process.env.RANGO_VERCEL_CACHE_E2E ?? "",
    ),
  },
});
