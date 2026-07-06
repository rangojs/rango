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
  // Fold the trace-debug gate at BUILD time. Read at build (not runtime) so a
  // normal `vite build` (env unset -> "") makes `traceDebugEnabled` a constant
  // false: the /__debug/trace `.use()` and the in-memory recorder are dead-code
  // eliminated and cannot be re-enabled by a runtime env var on a real deploy.
  // The e2e builds with RANGO_TRACE_DEBUG=1 in scope (see e2e/helper.ts), which
  // folds to "1" and keeps the debug path.
  define: {
    "process.env.RANGO_TRACE_DEBUG": JSON.stringify(
      process.env.RANGO_TRACE_DEBUG ?? "",
    ),
  },
});
