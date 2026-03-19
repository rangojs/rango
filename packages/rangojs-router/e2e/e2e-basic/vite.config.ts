import { defineConfig } from "vite";
import path from "path";
import { rango } from "@rangojs/router/vite";

export default defineConfig({
  cacheDir: process.env.RANGO_E2E_VITE_CACHE_DIR,
  plugins: [rango()],
  esbuild: {
    target: "es2022",
  },
  build: {
    sourcemap: true,
  },
  resolve: {
    dedupe: ["react", "react-dom"],
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
