import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { rango } from "@rangojs/router/vite";

// Multi-app host router on Vercel. rango owns the RSC entry, so the host module
// exports the HostRouter instance and `hostRouter` points at it.
export default defineConfig({
  plugins: [
    react(),
    rango({ preset: "vercel", hostRouter: "./src/worker.rsc.tsx" }),
  ],
});
